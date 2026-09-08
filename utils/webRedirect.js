const { WEB_APP_URL, ALLOWED_ORIGINS } = require("../config");

// Schéma de l'app mobile — conservé pour ne pas casser les rebonds deep-link
// existants (reset de mot de passe, invitations).
const MOBILE_APP_SCHEME = "mytripcircle:";

const MAX_URL_LENGTH = 2048;

// Une URL de retour fournie par le client et redirigée telle quelle est une
// redirection ouverte (phishing, vol de jeton via le Referer). On n'accepte
// donc qu'une origine explicitement listée — jamais une concaténation.
function allowedOrigins() {
  const origins = new Set(ALLOWED_ORIGINS);
  if (WEB_APP_URL) {
    try {
      origins.add(new URL(WEB_APP_URL).origin);
    } catch {
      // WEB_APP_URL malformé : ignoré ici, signalé par buildWebAppUrl
    }
  }
  return origins;
}

function parseUrl(candidate) {
  if (typeof candidate !== "string" || candidate.length === 0) return null;
  if (candidate.length > MAX_URL_LENGTH) return null;
  try {
    return new URL(candidate);
  } catch {
    return null;
  }
}

/**
 * Valide une URL de retour fournie par le client.
 * Retourne l'URL normalisée si elle est autorisée, sinon null.
 */
function resolveReturnTo(candidate) {
  const url = parseUrl(candidate);
  if (!url) return null;
  // Des identifiants dans l'URL servent à masquer le vrai hôte (https://site-de-confiance@evil.tld)
  if (url.username || url.password) return null;

  if (url.protocol === MOBILE_APP_SCHEME) return url.toString();
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  return allowedOrigins().has(url.origin) ? url.toString() : null;
}

/**
 * Construit une URL absolue vers le front web à partir d'un chemin interne.
 * Retourne null quand WEB_APP_URL n'est pas configuré (déploiement mobile seul).
 */
function buildWebAppUrl(path, params = {}) {
  if (!WEB_APP_URL) return null;
  const url = parseUrl(`${WEB_APP_URL}${path.startsWith("/") ? path : `/${path}`}`);
  if (!url) return null;
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

module.exports = { MOBILE_APP_SCHEME, resolveReturnTo, buildWebAppUrl, allowedOrigins };
