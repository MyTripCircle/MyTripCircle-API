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

/**
 * Consigne les accès aux routes touchant aux données personnelles.
 *
 * La liste des routes auditées est explicite plutôt que déduite d'une règle
 * générale : tout journaliser reviendrait à constituer un historique de
 * navigation complet, soit un traitement de données personnelles créé pour se
 * conformer à une obligation de traçabilité. Seuls l'export, la suppression,
 * la consultation d'annuaire, le recueil de consentement et le changement de
 * mot de passe sont retenus.
 *
 * L'écriture est différée par `setImmediate` afin que la réponse ne dépende pas
 * de la base d'audit : une indisponibilité de MongoDB doit dégrader la
 * traçabilité, jamais bloquer l'utilisateur dans l'exercice de ses droits. Pour
 * la même raison, l'échec d'insertion est journalisé sans être propagé.
 *
 * La durée de conservation n'est pas gérée ici mais par l'index TTL d'un an
 * posé sur `auditLogs.createdAt` dans `db.js`, de sorte que l'expiration
 * s'applique indépendamment de l'exécution du serveur.
 *
 * @param {import("express").Request} req Requête entrante ; `req.user` est lu
 *   s'il a été renseigné par `requireAuth` en amont.
 * @param {import("express").Response} res Réponse, non modifiée par ce
 *   middleware.
 * @param {import("express").NextFunction} next Passe systématiquement la main,
 *   que la route soit auditée ou non.
 * @returns {void}
 */
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
