const logger = require("../utils/logger");

// Endpoints contenant des données personnelles à tracer
const AUDITED_ROUTES = [
  { method: "GET",    pattern: /^\/users\/me\/export$/ },
  { method: "DELETE", pattern: /^\/users\/me$/ },
  { method: "GET",    pattern: /^\/users\/lookup/ },
  { method: "POST",   pattern: /^\/users\/batch$/ },
];

function auditLog(req, res, next) {
  const userId = req.user?._id ? String(req.user._id) : "anonymous";
  const isAudited = AUDITED_ROUTES.some(
    (r) => r.method === req.method && r.pattern.test(req.path)
  );

  if (isAudited) {
    logger.info(`[audit] ${req.method} ${req.path} — userId=${userId} — ip=${req.ip}`);
  }

  next();
}

module.exports = { auditLog };
