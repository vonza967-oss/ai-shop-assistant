const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 20;
const chatRequestLog = new Map();

function getClientKey(req) {
  const forwardedFor = req.headers["x-forwarded-for"];

  if (typeof forwardedFor === "string" && forwardedFor.trim()) {
    return forwardedFor.split(",")[0].trim();
  }

  return req.ip || req.socket?.remoteAddress || "unknown";
}

export function enforceChatRateLimit(req, res, next) {
  const clientKey = getClientKey(req);
  const now = Date.now();
  const recentRequests = (chatRequestLog.get(clientKey) || []).filter(
    (timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS
  );

  if (recentRequests.length >= RATE_LIMIT_MAX_REQUESTS) {
    return res.status(429).json({
      error: "Too many chat requests. Please wait a moment and try again.",
    });
  }

  recentRequests.push(now);
  chatRequestLog.set(clientKey, recentRequests);
  next();
}

export function requireAdminToken(req, res, next) {
  const configuredToken = process.env.ADMIN_TOKEN;

  if (!configuredToken) {
    return res.status(503).json({
      error: "ADMIN_TOKEN is not configured on the server.",
    });
  }

  const requestToken =
    req.headers["x-admin-token"] ||
    (typeof req.headers.authorization === "string" &&
    req.headers.authorization.startsWith("Bearer ")
      ? req.headers.authorization.slice("Bearer ".length)
      : "");

  if (!requestToken || requestToken !== configuredToken) {
    return res.status(401).json({
      error: "Invalid or missing admin token.",
    });
  }

  next();
}
