from __future__ import annotations

import importlib.util
import logging
import os
import pathlib
import sys
import tempfile
import unittest


PLUGIN_FILE = pathlib.Path(__file__).with_name("__init__.py")
MANIFEST_FILE = pathlib.Path(__file__).with_name("plugin.yaml")
INSTALLER_FILE = pathlib.Path(__file__).with_name("install-wsl.sh")
SPEC = importlib.util.spec_from_file_location("hermes_control_approval_bridge", PLUGIN_FILE)
plugin = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = plugin
assert SPEC.loader is not None
SPEC.loader.exec_module(plugin)


class FakeTransport:
    def __init__(self, decisions=None):
        self.decisions = list(decisions or [])
        self.calls = []

    def request(self, method, path, **kwargs):
        self.calls.append((method, path, kwargs))
        if method == "GET":
            items, self.decisions = self.decisions, []
            return {"ok": True, "items": items}
        return {"ok": True}


class FailFirstPostTransport(FakeTransport):
    def __init__(self):
        super().__init__()
        self.failed = False

    def request(self, method, path, **kwargs):
        if method == "POST" and path == "/api/hermes/events" and not self.failed:
            self.failed = True
            raise RuntimeError("temporary network failure")
        return super().request(method, path, **kwargs)


class ControlledStopEvent:
    def __init__(self):
        self.waits = []
        self.stopped = False

    def is_set(self):
        return self.stopped

    def wait(self, timeout):
        self.waits.append(timeout)


class ApprovalBridgeTests(unittest.TestCase):
    def setUp(self):
        self.config = plugin.BridgeConfig(
            base_url="https://deck.example.test",
            token="test-token-that-is-never-logged",
            gateway_id="gateway-a",
            long_poll_ms=1,
        )

    def test_hook_input_is_queued_without_network_io(self):
        transport = FakeTransport()
        worker = plugin.ApprovalBridgeWorker(self.config, transport=transport, resolver=lambda **_: 1)

        worker.enqueue_requested({
            "command": "echo ok",
            "description": "Allow command?",
            "session_key": "session-1",
            "surface": "gateway",
            "turn_id": "turn-1",
            "tool_call_id": "tool-1",
        })

        self.assertEqual(transport.calls, [])
        self.assertEqual(worker.outbox.qsize(), 1)

    def test_full_requested_decision_ack_resolved_cycle(self):
        resolved_calls = []
        worker = plugin.ApprovalBridgeWorker(
            self.config,
            transport=FakeTransport(),
            resolver=lambda **kwargs: resolved_calls.append(kwargs) or 1,
        )
        worker.enqueue_requested({
            "command": "echo ok",
            "description": "Allow command?",
            "session_key": "session-1",
            "surface": "gateway",
            "turn_id": "turn-1",
            "tool_call_id": "tool-1",
        })
        requested = worker.outbox.queue[0]
        approval_id = requested["payload"]["approval_id"]
        worker.transport.decisions = [{
            "id": "decision/1",
            "approvalId": approval_id,
            "gatewayId": "gateway-a",
            "sessionId": "session-1",
            "choice": "once",
            "reason": "",
        }]

        worker.run_once()

        self.assertEqual(resolved_calls, [{"session_key": "session-1", "choice": "once", "reason": None}])
        calls = worker.transport.calls
        self.assertEqual(calls[0][0:2], ("POST", "/api/hermes/events"))
        self.assertEqual(calls[0][2]["payload"]["event"], "approval_requested")
        self.assertEqual(calls[1][0:2], ("GET", "/api/hermes/approval-decisions/claim"))
        self.assertEqual(calls[2][0:2], ("POST", "/api/hermes/approval-decisions/decision%2F1/ack"))
        self.assertEqual(calls[2][2]["payload"]["status"], "applied")
        self.assertEqual(calls[3][2]["payload"]["event"], "approval_resolved")
        self.assertEqual(calls[3][2]["payload"]["seq"], 1)

    def test_failed_resolver_is_acked_without_resolved_event(self):
        transport = FakeTransport([{
            "id": "decision-2",
            "approval_id": "approval-2",
            "session_id": "session-2",
            "choice": "deny",
        }])
        worker = plugin.ApprovalBridgeWorker(self.config, transport=transport, resolver=lambda **_: 0)

        worker.run_once()

        self.assertEqual(transport.calls[1][2]["payload"]["status"], "failed")
        self.assertEqual(len([call for call in transport.calls if call[1] == "/api/hermes/events"]), 0)

    def test_events_are_stable_and_match_receiver_contract(self):
        worker = plugin.ApprovalBridgeWorker(self.config, transport=FakeTransport(), resolver=lambda **_: 1)
        data = {
            "command": "pwd",
            "description": "Run pwd?",
            "session_key": "session-3",
            "surface": "gateway",
            "turn_id": "turn-3",
            "tool_call_id": "tool-3",
        }
        worker.enqueue_requested(data)
        first = worker.outbox.get_nowait()
        worker.enqueue_requested(data)
        second = worker.outbox.get_nowait()

        self.assertEqual(first["event_id"], second["event_id"])
        self.assertEqual(first["seq"], 0)
        self.assertEqual(first["source"], "hermes-control-relay")
        self.assertEqual(first["payload"]["gateway_id"], "gateway-a")
        self.assertEqual(first["session_id"], "session-3")

    def test_non_gateway_hook_is_ignored(self):
        original = plugin._worker
        worker = plugin.ApprovalBridgeWorker(self.config, transport=FakeTransport(), resolver=lambda **_: 1)
        plugin._worker = worker
        previous = os.environ.pop("HERMES_CLI_REMOTE_APPROVAL", None)
        try:
            plugin.on_approval_requested("pwd", "Run?", "p", ["p"], "session", "cli")
            self.assertTrue(worker.outbox.empty())
        finally:
            if previous is not None:
                os.environ["HERMES_CLI_REMOTE_APPROVAL"] = previous
            plugin._worker = original

    def test_cli_hook_requires_explicit_remote_approval_flag(self):
        original = plugin._worker
        worker = plugin.ApprovalBridgeWorker(self.config, transport=FakeTransport(), resolver=lambda **_: 1)
        plugin._worker = worker
        previous = os.environ.get("HERMES_CLI_REMOTE_APPROVAL")
        os.environ["HERMES_CLI_REMOTE_APPROVAL"] = "1"
        try:
            plugin.on_approval_requested("pwd", "Run?", "p", ["p"], "session", "cli")
            self.assertEqual(worker.outbox.qsize(), 1)
            event = worker.outbox.queue[0]
            self.assertEqual(event["payload"]["surface"], "cli")
        finally:
            if previous is None:
                os.environ.pop("HERMES_CLI_REMOTE_APPROVAL", None)
            else:
                os.environ["HERMES_CLI_REMOTE_APPROVAL"] = previous
            plugin._worker = original

    def test_network_retry_preserves_requested_before_resolved(self):
        transport = FailFirstPostTransport()
        worker = plugin.ApprovalBridgeWorker(self.config, transport=transport, resolver=lambda **_: 1)
        data = {
            "command": "pwd",
            "description": "Run?",
            "session_key": "session-4",
            "surface": "gateway",
            "turn_id": "turn-4",
            "tool_call_id": "tool-4",
        }
        worker.enqueue_requested(data)
        worker.enqueue_resolved({**data, "choice": "once", "status": "applied"})

        with self.assertRaisesRegex(RuntimeError, "temporary network failure"):
            worker._flush_outbox()
        worker._flush_outbox()

        posted_events = [call[2]["payload"]["event"] for call in transport.calls if call[1] == "/api/hermes/events"]
        self.assertEqual(posted_events, ["approval_requested", "approval_resolved"])

    def test_unavailable_bridge_uses_backoff_and_rate_limited_logs(self):
        records = []
        logger = logging.getLogger("approval-bridge-backoff-test")
        logger.handlers.clear()
        logger.propagate = False
        logger.setLevel(logging.INFO)
        handler = logging.Handler()
        handler.emit = records.append
        logger.addHandler(handler)

        worker = plugin.ApprovalBridgeWorker(
            self.config,
            transport=FakeTransport(),
            logger=logger,
        )
        worker.stop_event = ControlledStopEvent()
        attempts = 0

        def run_once():
            nonlocal attempts
            attempts += 1
            if attempts <= 2:
                raise RuntimeError("deck asleep")
            worker.stop_event.stopped = True
            return False

        worker.run_once = run_once
        worker._run()

        self.assertEqual(worker.stop_event.waits, [1.0, 2.0])
        self.assertEqual([record.levelno for record in records], [logging.WARNING, logging.INFO])
        self.assertIn("unavailable", records[0].getMessage())
        self.assertIn("connection restored", records[1].getMessage())
        logger.removeHandler(handler)

    def test_config_can_be_loaded_from_private_hermes_env_file(self):
        with tempfile.TemporaryDirectory() as directory:
            config_path = pathlib.Path(directory) / "bridge.env"
            config_path.write_text(
                "HERMES_CONTROL_URL=https://deck.example.test\n"
                "HERMES_CONTROL_BRIDGE_TOKEN=file-token\n"
                "HERMES_CONTROL_GATEWAY_ID=gateway-from-file\n",
                encoding="utf-8",
            )
            config = plugin.BridgeConfig.from_env({}, config_path=config_path)
        self.assertEqual(config.gateway_id, "gateway-from-file")
        self.assertEqual(config.token, "file-token")

    def test_manifest_and_installer_use_the_same_plugin_name_without_env_gating(self):
        manifest = MANIFEST_FILE.read_text(encoding="utf-8")
        installer = INSTALLER_FILE.read_text(encoding="utf-8")
        self.assertIn("name: hermes-control-approval-bridge", manifest)
        self.assertIn("kind: standalone", manifest)
        self.assertIn("pre_approval_request", manifest)
        self.assertIn("post_approval_response", manifest)
        self.assertNotIn("requires_env:", manifest)
        self.assertIn("hermes plugins enable hermes-control-approval-bridge", installer)


if __name__ == "__main__":
    unittest.main()
