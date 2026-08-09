"""Hermes Gateway approval bridge for Hermes Control Deck.

The Hermes hook callbacks are deliberately synchronous and non-blocking. They
only enqueue sanitized event data; one daemon worker owns all network I/O and
calls the official Gateway approval resolver.
"""

from __future__ import annotations

import atexit
import hashlib
import json
import logging
import os
import pathlib
import queue
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Mapping, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import Request, urlopen


LOGGER = logging.getLogger(__name__)
ALLOWED_CHOICES = frozenset({"once", "session", "always", "deny"})
DEFAULT_LONG_POLL_MS = 1_000
DEFAULT_RETRY_SECONDS = 1.0
DEFAULT_MAX_RETRY_SECONDS = 60.0
DEFAULT_ERROR_LOG_INTERVAL_SECONDS = 60.0


@dataclass(frozen=True)
class BridgeConfig:
    base_url: str
    token: str
    gateway_id: str
    long_poll_ms: int = DEFAULT_LONG_POLL_MS
    retry_seconds: float = DEFAULT_RETRY_SECONDS
    max_retry_seconds: float = DEFAULT_MAX_RETRY_SECONDS
    error_log_interval_seconds: float = DEFAULT_ERROR_LOG_INTERVAL_SECONDS

    @classmethod
    def from_env(
        cls,
        env: Mapping[str, str] = os.environ,
        config_path: Optional[pathlib.Path] = None,
    ) -> "BridgeConfig":
        file_values = _read_env_file(config_path or pathlib.Path.home() / ".hermes" / "hermes-control-approval-bridge.env")
        values = {**file_values, **dict(env)}
        base_url = str(values.get("HERMES_CONTROL_URL", "")).strip().rstrip("/")
        token = str(values.get("HERMES_CONTROL_BRIDGE_TOKEN", "")).strip()
        gateway_id = str(values.get("HERMES_CONTROL_GATEWAY_ID", "")).strip()
        if not base_url:
            raise ValueError("HERMES_CONTROL_URL is required")
        parsed = urlsplit(base_url)
        is_loopback = parsed.hostname in {"127.0.0.1", "localhost", "::1"}
        if parsed.scheme != "https" and not (parsed.scheme == "http" and is_loopback):
            raise ValueError("HERMES_CONTROL_URL must use HTTPS (HTTP is allowed only for loopback testing)")
        if not token:
            raise ValueError("HERMES_CONTROL_BRIDGE_TOKEN is required")
        if not gateway_id or len(gateway_id) > 120:
            raise ValueError("HERMES_CONTROL_GATEWAY_ID must contain 1-120 characters")
        return cls(base_url=base_url, token=token, gateway_id=gateway_id)


class JsonTransport:
    def __init__(self, config: BridgeConfig):
        self.config = config

    def request(
        self,
        method: str,
        path: str,
        *,
        query: Optional[Mapping[str, Any]] = None,
        payload: Optional[Mapping[str, Any]] = None,
        timeout: float = 10.0,
    ) -> Mapping[str, Any]:
        url = f"{self.config.base_url}/{path.lstrip('/')}"
        if query:
            url = f"{url}?{urlencode(query)}"
        body = None if payload is None else json.dumps(payload, separators=(",", ":")).encode("utf-8")
        headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {self.config.token}",
            "User-Agent": "hermes-control-approval-bridge/0.1.0",
        }
        if body is not None:
            headers["Content-Type"] = "application/json"
        request = Request(url, data=body, headers=headers, method=method)
        try:
            with urlopen(request, timeout=timeout) as response:
                raw = response.read()
        except HTTPError as error:
            detail = error.read(512).decode("utf-8", errors="replace")
            raise RuntimeError(f"Hermes Control returned HTTP {error.code}: {detail}") from error
        except (URLError, TimeoutError, OSError) as error:
            raise RuntimeError(f"Hermes Control request failed: {error}") from error
        if not raw:
            return {}
        parsed = json.loads(raw.decode("utf-8"))
        if not isinstance(parsed, dict):
            raise RuntimeError("Hermes Control returned a non-object JSON response")
        return parsed


class ApprovalBridgeWorker:
    def __init__(
        self,
        config: BridgeConfig,
        *,
        transport: Optional[JsonTransport] = None,
        resolver: Optional[Callable[..., int]] = None,
        logger: logging.Logger = LOGGER,
    ):
        self.config = config
        self.transport = transport or JsonTransport(config)
        self._resolver = resolver
        self.logger = logger
        self.outbox: "queue.Queue[dict[str, Any]]" = queue.Queue()
        self.stop_event = threading.Event()
        self.thread: Optional[threading.Thread] = None
        self._pending_lock = threading.Lock()
        self._pending: dict[str, dict[str, Any]] = {}
        self._retry_event: Optional[dict[str, Any]] = None
        self._bridge_offline = False
        self._last_error_logged_at = 0.0

    def start(self) -> None:
        if self.thread and self.thread.is_alive():
            return
        self.thread = threading.Thread(
            target=self._run,
            name="hermes-control-approval-bridge",
            daemon=True,
        )
        self.thread.start()

    def stop(self) -> None:
        self.stop_event.set()

    def enqueue_requested(self, data: Mapping[str, Any]) -> None:
        approval = self._approval_data(data)
        with self._pending_lock:
            self._pending[approval["approval_id"]] = approval
        self.outbox.put(self._event("approval_requested", approval, seq=0))

    def enqueue_resolved(self, data: Mapping[str, Any]) -> None:
        approval = self._approval_data(data)
        with self._pending_lock:
            existing = self._pending.get(approval["approval_id"], {})
            approval = {**existing, **approval}
        self.outbox.put(self._event("approval_resolved", approval, seq=1))

    def run_once(self) -> bool:
        did_work = self._flush_outbox()
        response = self.transport.request(
            "GET",
            "/api/hermes/approval-decisions/claim",
            query={
                "gateway_id": self.config.gateway_id,
                "limit": 1,
                "wait_ms": self.config.long_poll_ms,
            },
            timeout=max(10.0, self.config.long_poll_ms / 1000.0 + 5.0),
        )
        items = response.get("items", [])
        if not isinstance(items, list):
            raise RuntimeError("Hermes Control decision response has invalid items")
        for decision in items:
            if not isinstance(decision, dict):
                continue
            self._apply_decision(decision)
            did_work = True
        if did_work:
            self._flush_outbox()
        return did_work

    def _run(self) -> None:
        retry_delay = max(0.001, self.config.retry_seconds)
        while not self.stop_event.is_set():
            try:
                self.run_once()
            except Exception as error:  # Plugin failures must never break Hermes.
                now = time.monotonic()
                log_interval = max(0.0, self.config.error_log_interval_seconds)
                should_log = (
                    not self._bridge_offline
                    or now - self._last_error_logged_at >= log_interval
                )
                if should_log:
                    state = "still unavailable" if self._bridge_offline else "unavailable"
                    self.logger.warning(
                        "Hermes Control approval bridge %s; retrying in %.1fs: %s",
                        state,
                        retry_delay,
                        self._safe_error(error),
                    )
                    self._last_error_logged_at = now
                self._bridge_offline = True
                self.stop_event.wait(retry_delay)
                retry_delay = min(
                    retry_delay * 2,
                    max(retry_delay, self.config.max_retry_seconds),
                )
            else:
                if self._bridge_offline:
                    self.logger.info("Hermes Control approval bridge connection restored")
                self._bridge_offline = False
                self._last_error_logged_at = 0.0
                retry_delay = max(0.001, self.config.retry_seconds)

    def _flush_outbox(self) -> bool:
        did_work = False
        while True:
            from_queue = self._retry_event is None
            if from_queue:
                try:
                    event = self.outbox.get_nowait()
                except queue.Empty:
                    return did_work
            else:
                event = self._retry_event
            try:
                self.transport.request("POST", "/api/hermes/events", payload=event, timeout=10.0)
            except Exception:
                # Preserve FIFO ordering across a network failure. In
                # particular, resolved must never overtake requested.
                self._retry_event = event
                raise
            finally:
                if from_queue:
                    self.outbox.task_done()
            self._retry_event = None
            did_work = True

    def _apply_decision(self, decision: Mapping[str, Any]) -> None:
        decision_id = _first_text(decision, "id", "decision_id", "decisionId", limit=220)
        approval_id = _first_text(decision, "approval_id", "approvalId", limit=180)
        session_key = _first_text(decision, "session_id", "sessionId", limit=180)
        choice = _first_text(decision, "choice", limit=40).lower()
        reason = _first_text(decision, "reason", limit=500)
        if not decision_id or not approval_id or not session_key or choice not in ALLOWED_CHOICES:
            raise RuntimeError("Hermes Control returned an invalid approval decision")

        status = "applied"
        error_text = ""
        try:
            resolved = int(self._get_resolver()(session_key=session_key, choice=choice, reason=reason or None))
            if resolved < 1:
                status = "failed"
                error_text = "No pending Hermes approval matched the decision"
        except Exception as error:  # ACK failure without exposing command, reason, or token.
            status = "failed"
            error_text = self._safe_error(error)

        self.transport.request(
            "POST",
            f"/api/hermes/approval-decisions/{quote(decision_id, safe='')}/ack",
            payload={
                "gateway_id": self.config.gateway_id,
                "status": status,
                **({"error": error_text[:500]} if error_text else {}),
            },
            timeout=10.0,
        )
        if status != "applied":
            return

        with self._pending_lock:
            approval = dict(self._pending.get(approval_id, {}))
        approval.update({
            "approval_id": approval_id,
            "session_key": session_key,
            "choice": choice,
            "decision_id": decision_id,
            "status": "applied",
            "surface": _text(approval.get("surface"), 40) or "gateway",
        })
        # post_approval_response also enqueues this event. The stable event ID
        # makes the second delivery an intentional, harmless duplicate.
        self.outbox.put(self._event("approval_resolved", approval, seq=1))

    def _get_resolver(self) -> Callable[..., int]:
        if self._resolver is None:
            from tools.approval import resolve_gateway_approval

            self._resolver = resolve_gateway_approval
        return self._resolver

    def _approval_data(self, data: Mapping[str, Any]) -> dict[str, Any]:
        session_key = _text(data.get("session_key"), 180)
        command = _text(data.get("command"), 1200)
        description = _text(data.get("description"), 800)
        turn_id = _text(data.get("turn_id"), 180)
        tool_call_id = _text(data.get("tool_call_id"), 180)
        approval_id = _text(data.get("approval_id"), 180) or _approval_id(
            self.config.gateway_id,
            session_key,
            turn_id,
            tool_call_id,
            command,
        )
        return {
            "approval_id": approval_id,
            "gateway_id": self.config.gateway_id,
            "session_key": session_key,
            "command": command,
            "question": description,
            "surface": _text(data.get("surface"), 40) or "gateway",
            "turn_id": turn_id,
            "tool_call_id": tool_call_id,
            "choice": _text(data.get("choice"), 40),
            "decision_id": _text(data.get("decision_id"), 220),
            "status": _text(data.get("status"), 40),
        }

    def _event(self, event_type: str, approval: Mapping[str, Any], *, seq: int) -> dict[str, Any]:
        approval_id = str(approval["approval_id"])
        run_id = f"approval:{approval_id}"
        payload = {
            "approval_id": approval_id,
            "gateway_id": self.config.gateway_id,
            "command": _text(approval.get("command"), 1200),
            "question": _text(approval.get("question"), 800),
            "surface": _text(approval.get("surface"), 40) or "gateway",
        }
        if event_type == "approval_resolved":
            payload.update({
                "decision_id": _text(approval.get("decision_id"), 220),
                "choice": _text(approval.get("choice"), 40),
                "status": _text(approval.get("status"), 40) or "applied",
            })
        return {
            "event_id": f"{approval_id}:{'requested' if seq == 0 else 'resolved'}",
            "run_id": run_id,
            "seq": seq,
            "event": event_type,
            "created_at": _utc_now(),
            "session_id": _text(approval.get("session_key"), 180),
            "task_id": run_id,
            "profile": "default",
            "source": "hermes-control-relay",
            "payload": payload,
        }

    def _safe_error(self, error: BaseException) -> str:
        message = str(error)
        if self.config.token:
            message = message.replace(self.config.token, "[redacted]")
        return _text(message, 500) or error.__class__.__name__


_worker: Optional[ApprovalBridgeWorker] = None
_worker_lock = threading.Lock()


def on_approval_requested(
    command: str,
    description: str,
    pattern_key: str,
    pattern_keys: list[str],
    session_key: str,
    surface: str,
    **kwargs: Any,
) -> None:
    del pattern_key, pattern_keys
    if not _relay_surface(surface) or _worker is None:
        return
    _worker.enqueue_requested({
        "command": command,
        "description": description,
        "session_key": session_key,
        "surface": surface,
        "turn_id": kwargs.get("turn_id"),
        "tool_call_id": kwargs.get("tool_call_id"),
    })


def on_approval_resolved(
    command: str,
    description: str,
    pattern_key: str,
    pattern_keys: list[str],
    session_key: str,
    surface: str,
    choice: str,
    **kwargs: Any,
) -> None:
    del pattern_key, pattern_keys
    if not _relay_surface(surface) or _worker is None:
        return
    _worker.enqueue_resolved({
        "command": command,
        "description": description,
        "session_key": session_key,
        "surface": surface,
        "choice": choice,
        "status": "applied",
        "turn_id": kwargs.get("turn_id"),
        "tool_call_id": kwargs.get("tool_call_id"),
    })


def register(ctx: Any) -> None:
    global _worker
    try:
        config = BridgeConfig.from_env()
    except ValueError as error:
        LOGGER.warning("Hermes Control approval bridge is disabled: %s", error)
        return
    with _worker_lock:
        if _worker is None or not (_worker.thread and _worker.thread.is_alive()):
            _worker = ApprovalBridgeWorker(config)
            _worker.start()
            atexit.register(_worker.stop)
    ctx.register_hook("pre_approval_request", on_approval_requested)
    ctx.register_hook("post_approval_response", on_approval_resolved)


def _relay_surface(surface: str) -> bool:
    """Allow CLI hooks only when Hermes was explicitly put in remote mode.

    Gateway approvals remain unchanged. The CLI branch is deliberately
    opt-in because accepting a hook event alone cannot move an interactive
    stdin approval into Hermes' gateway queue; the upstream Hermes approval
    handler must also be configured with HERMES_CLI_REMOTE_APPROVAL=1.
    """
    normalized = _text(surface, 40).lower()
    if normalized == "gateway":
        return True
    return normalized == "cli" and os.environ.get("HERMES_CLI_REMOTE_APPROVAL") == "1"


def _approval_id(gateway_id: str, session_key: str, turn_id: str, tool_call_id: str, command: str) -> str:
    material = "\0".join((gateway_id, session_key, turn_id, tool_call_id, command)).encode("utf-8")
    return f"hermes-approval:{hashlib.sha256(material).hexdigest()}"


def _first_text(source: Mapping[str, Any], *keys: str, limit: int) -> str:
    for key in keys:
        value = _text(source.get(key), limit)
        if value:
            return value
    return ""


def _text(value: Any, limit: int) -> str:
    if value is None:
        return ""
    return " ".join(str(value).split())[:limit]


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _read_env_file(path: pathlib.Path) -> dict[str, str]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return {}
    except OSError as error:
        LOGGER.warning("Hermes Control approval bridge config could not be read: %s", error)
        return {}
    values: dict[str, str] = {}
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        values[key.strip()] = value.strip().strip("\"'")
    return values
