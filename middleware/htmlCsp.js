const crypto = require("node:crypto");

// La CSP globale (`script-src 'none'`) est la bonne valeur pour une API JSON,
// mais elle casse les rares pages HTML servies par le backend qui ont besoin
// d'un script inline (rebond deep-link du reset de mot de passe).
// Plutôt que de relâcher la politique sur toute l'API, on remplace l'en-tête
// pour ces routes uniquement, avec un nonce à usage unique : aucun script
// injecté (XSS) ne pourra s'exécuter sans connaître le nonce.
function htmlPageCsp(_req, res, next) {
  const nonce = crypto.randomBytes(16).toString("base64");
  res.locals.cspNonce = nonce;

  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      `script-src 'nonce-${nonce}'`,
      "style-src 'unsafe-inline'",
      "img-src 'self' data:",
      "form-action 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join("; ")
  );

  next();
}

module.exports = { htmlPageCsp };
