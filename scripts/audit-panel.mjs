const baseUrl = process.env.CONTROL_BASE_URL || `http://${process.env.CONTROL_SERVER_HOST || "127.0.0.1"}:${process.env.CONTROL_SERVER_PORT || "4240"}`;
const token = process.env.CONTROL_AUTH_TOKEN || "";
const headers = token ? { Authorization: `Bearer ${token}` } : {};

const checks = [
  ["health", "/healthz"],
  ["runtimes", "/api/runtimes"],
  ["agents", "/api/agents"],
  ["tasks", "/api/tasks"],
  ["sessions", "/api/conversations"],
  ["approvals", "/api/approvals"],
  ["events", "/api/events?limit=10&minutes=15"]
];

let failed = 0;
for (const [name, route] of checks) {
  try {
    const response = await fetch(`${baseUrl}${route}`, { headers });
    const body = await response.json().catch(() => ({}));
    const ok = response.ok && body.ok !== false;
    console.log(`${ok ? "PASS" : "FAIL"} ${name} ${response.status}`);
    if (!ok) failed += 1;
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name} ${error.message}`);
  }
}

process.exitCode = failed ? 1 : 0;
