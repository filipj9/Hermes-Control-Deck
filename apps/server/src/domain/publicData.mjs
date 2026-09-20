const BLOCKED_KEYS = new Set([
  "raw",
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "password",
  "passwd",
  "secret",
  "clientsecret",
  "privatekey",
  "apikey",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "token",
  "ticket"
]);

export function sanitizePublicData(value, stack = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (stack.has(value)) return "[Circular]";

  stack.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => sanitizePublicData(item, stack));
    }

    const output = {};
    for (const [key, item] of Object.entries(value)) {
      if (isSensitiveKey(key)) continue;
      output[key] = sanitizePublicData(item, stack);
    }
    return output;
  } finally {
    stack.delete(value);
  }
}

function isSensitiveKey(key) {
  const normalized = String(key || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (BLOCKED_KEYS.has(normalized)) return true;
  return normalized.endsWith("password")
    || normalized.endsWith("secret")
    || normalized.endsWith("privatekey")
    || normalized.endsWith("apikey")
    || normalized.endsWith("accesstoken")
    || normalized.endsWith("refreshtoken")
    || normalized.endsWith("wstoken")
    || normalized.endsWith("ticket");
}
