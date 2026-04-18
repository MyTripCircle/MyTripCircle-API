const logger = require("../utils/logger");
const { getDb } = require("../db");

// RGPD Art. 5(f) + Art. 32 — Traçabilité des accès aux données personnelles sensibles
const AUDITED_ROUTES = [
  { method: "GET",    pattern: /^\/users\/me\/export$/ },
  { method: "DELETE", pattern: /^\/users\/me$/ },
  { method: "POST",   pattern: /^\/users\/me\/cancel-deletion$/ },
  { method: "GET",    pattern: /^\/users\/lookup/ },
  { method: "POST",   pattern: /^\/users\/batch$/ },
  { method: "POST",   pattern: /^\/users\/consent$/ },
  { method: "PUT",    pattern: /^\/users\/change-password$/ },
  { method: "DELETE", pattern: /^\/users\/me\/account$/ },
];

function auditLog(req, res, next) {
  const userId = req.user?._id ? String(req.user._id) : "anonymous";
  const isAudited = AUDITED_ROUTES.some(
    (r) => r.method === req.method && r.pattern.test(req.path)
  );

  if (isAudited) {
    logger.info(`[audit] ${req.method} ${req.path} — userId=${userId} — ip=${req.ip}`);

    // Persistance asynchrone en MongoDB (non-bloquant)
    // Le TTL de 1 an est configuré dans db.js via l'index auditLogs.createdAt
    setImmediate(() => {
      try {
        const db = getDb();
        db.collection("auditLogs").insertOne({
          method: req.method,
          path: req.path,
          userId,
          ip: req.ip,
          userAgent: req.headers["user-agent"] || null,
          createdAt: new Date(),
        }).catch((err) => logger.error("[auditLog] Erreur persistence MongoDB:", err.message));
      } catch (e) {
        logger.warn("[auditLog] DB non disponible, audit ignoré:", e.message);
      }
    });
  }

  next();
}

module.exports = { auditLog };
