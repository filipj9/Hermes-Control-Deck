#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${HOME}/.hermes/plugins/hermes-control-approval-bridge"
CONFIG_FILE="${HOME}/.hermes/hermes-control-approval-bridge.env"

read -r -p "Hermes Control HTTPS URL: " control_url
read -r -p "Gateway ID [$(hostname)]: " gateway_id
gateway_id="${gateway_id:-$(hostname)}"
read -r -s -p "Hermes Control bridge token: " bridge_token
printf '\n'

if [[ "${control_url}" != https://* ]]; then
  echo "ERROR: Hermes Control URL must use HTTPS." >&2
  exit 1
fi
if [[ -z "${bridge_token}" ]]; then
  echo "ERROR: bridge token cannot be empty." >&2
  exit 1
fi

mkdir -p "${TARGET_DIR}"
install -m 0644 "${SOURCE_DIR}/__init__.py" "${TARGET_DIR}/__init__.py"
install -m 0644 "${SOURCE_DIR}/plugin.yaml" "${TARGET_DIR}/plugin.yaml"
cat > "${CONFIG_FILE}" <<EOF
HERMES_CONTROL_URL=${control_url%/}
HERMES_CONTROL_BRIDGE_TOKEN=${bridge_token}
HERMES_CONTROL_GATEWAY_ID=${gateway_id}
EOF
chmod 0600 "${CONFIG_FILE}"

if ! command -v hermes >/dev/null 2>&1; then
  echo "ERROR: hermes CLI is not available in PATH." >&2
  exit 1
fi

hermes plugins enable hermes-control-approval-bridge
hermes plugins list | grep -F "hermes-control-approval-bridge" >/dev/null
echo "Installed. Restart only the Hermes Gateway service/process once, then run the real approval E2E test."
