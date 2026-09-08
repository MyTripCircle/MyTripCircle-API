const crypto = require("node:crypto");
const { ALLOWED_ORIGINS } = require("../config");
const { CSRF_COOKIE, CSRF_HEADER, hasAuthCookie } = require("../utils/authCookies");
const logger = require("../utils/logger");

// ─── Stratégie CSRF ───────────────────────────────────────────────────────────
// Poser un cookie de session crée une autorité ambiante : un site tiers peut
// déclencher une requête mutante authentifiée à l'insu de l'utilisateur.
// Deux barrières complémentaires sont appliquées, et uniquement quand la requête
// s'appuie réellement sur le cookie :
//   1. Vérification de provenance (Origin + Sec-Fetch-Site) — bloque les
//      soumissions cross-site, y compris les formulaires HTML qui échappent au
//      preflight CORS.
//   2. Double-submit token — le serveur pose un jeton aléatoire dans un cookie
//      lisible et exige le même jeton dans l'en-tête X-CSRF-Token. Un site tiers
//      ne peut ni lire le cookie (same-origin policy) ni poser un en-tête
//      personnalisé sans preflight autorisé. Ce choix (plutôt qu'un jeton
//      synchronisé en session) évite tout état serveur supplémentaire.
// Les requêtes portant un `Authorization: Bearer` sont exemptées : un en-tête
// personnalisé ne peut pas être forgé cross-site, et l'app mobile reste
// strictement inchangée.
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const ALLOWED_FETCH_SITES = new Set(["same-origin", "same-site", "none"]);

function timingSafeEquals(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function isTrustedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return null; // pas d'Origin : arbitré par Sec-Fetch-Site
  const selfOrigin = `${req.protocol}://${req.get("host")}`;
  return ALLOWED_ORIGINS.includes(origin) || origin === selfOrigin;
}

// Retourne un message d'erreur, ou null si la provenance est acceptable.
function checkProvenance(req) {
  const fetchSite = req.headers["sec-fetch-site"];
  if (fetchSite && !ALLOWED_FETCH_SITES.has(fetchSite)) {
    return "Requête cross-site refusée";
  }

  const originTrusted = isTrustedOrigin(req);
  if (originTrusted === false) return "Origine non autorisée";
  // Aucun indice de provenance alors que la requête utilise un cookie : un
  // navigateur en envoie toujours au moins un sur une requête mutante.
  if (originTrusted === null && !fetchSite) return "Origine manquante";
  return null;
}

function hasValidCsrfToken(req) {
  const cookieToken = req.cookies?.[CSRF_COOKIE];
  const headerToken = req.get(CSRF_HEADER);
  if (!cookieToken || !headerToken) return false;
  return timingSafeEquals(cookieToken, headerToken);
}

function csrfProtection(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  if (req.headers.authorization?.startsWith("Bearer ")) return next();
  if (!hasAuthCookie(req)) return next();

  const provenanceError = checkProvenance(req);
  if (provenanceError) {
    logger.warn(`[csrf] ${provenanceError} — ${req.method} ${req.path}`);
    return res.status(403).json({ success: false, error: provenanceError });
  }

  if (!hasValidCsrfToken(req)) {
    logger.warn(`[csrf] Jeton CSRF absent ou invalide — ${req.method} ${req.path}`);
    return res.status(403).json({ success: false, error: "Jeton CSRF invalide" });
  }

  return next();
}

module.exports = { csrfProtection };
