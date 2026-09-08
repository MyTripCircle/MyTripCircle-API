const crypto = require("node:crypto");
const { IS_PRODUCTION, COOKIE_DOMAIN } = require("../config");

// Dans un navigateur, un JWT stocké en JS (localStorage/mémoire) est exfiltrable
// par la moindre XSS. On double donc l'en-tête `Authorization` (toujours
// supporté, notamment pour l'app mobile) par des cookies httpOnly.
const ACCESS_COOKIE = "mtc_access";
const REFRESH_COOKIE = "mtc_refresh";
// Volet « lisible » du double-submit CSRF : ce cookie n'est PAS httpOnly, le
// front doit le relire (ou lire `csrfToken` dans la réponse de login) et le
// renvoyer dans l'en-tête X-CSRF-Token sur chaque requête mutante.
const CSRF_COOKIE = "mtc_csrf";
const CSRF_HEADER = "x-csrf-token";

// Le refresh token n'est utile que sur la route de rafraîchissement : le
// restreindre limite sa surface d'exposition (il n'est pas envoyé au reste de
// l'API, donc pas volable via une faille sur une autre route).
const REFRESH_COOKIE_PATH = "/users/refresh";

// Alignés sur les durées de vie des JWT (cf. authHelpers)
const ACCESS_MAX_AGE_MS = 15 * 60 * 1000;
const REFRESH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function cookieOptions({ path, maxAge, httpOnly = true }) {
  return {
    httpOnly,
    // `secure` désactivé hors production : le dev tourne en http://localhost
    secure: IS_PRODUCTION,
    sameSite: "lax",
    path,
    maxAge,
    ...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {}),
  };
}

function generateCsrfToken() {
  return crypto.randomBytes(32).toString("base64url");
}

/**
 * Pose les cookies de session et retourne le jeton CSRF associé, que l'appelant
 * doit renvoyer dans le corps JSON (le front ne peut pas lire le cookie quand
 * l'API est sur un autre sous-domaine).
 */
function setAuthCookies(res, { accessToken, refreshToken }) {
  const csrfToken = generateCsrfToken();

  res.cookie(ACCESS_COOKIE, accessToken, cookieOptions({ path: "/", maxAge: ACCESS_MAX_AGE_MS }));
  res.cookie(
    REFRESH_COOKIE,
    refreshToken,
    cookieOptions({ path: REFRESH_COOKIE_PATH, maxAge: REFRESH_MAX_AGE_MS })
  );
  res.cookie(
    CSRF_COOKIE,
    csrfToken,
    cookieOptions({ path: "/", maxAge: REFRESH_MAX_AGE_MS, httpOnly: false })
  );

  return csrfToken;
}

/**
 * Réponse de session unifiée : cookies httpOnly pour le navigateur, jetons dans
 * le corps pour l'app mobile (contrat existant inchangé), plus le jeton CSRF à
 * renvoyer dans X-CSRF-Token sur les requêtes mutantes.
 */
function sendSessionResponse(res, { accessToken, refreshToken, extra = {} }) {
  const csrfToken = setAuthCookies(res, { accessToken, refreshToken });
  return res.json({ success: true, token: accessToken, refreshToken, csrfToken, ...extra });
}

function clearAuthCookies(res) {
  res.clearCookie(ACCESS_COOKIE, cookieOptions({ path: "/" }));
  res.clearCookie(REFRESH_COOKIE, cookieOptions({ path: REFRESH_COOKIE_PATH }));
  res.clearCookie(CSRF_COOKIE, cookieOptions({ path: "/", httpOnly: false }));
}

function readAccessTokenFromCookie(req) {
  return req.cookies?.[ACCESS_COOKIE] || null;
}

function readRefreshTokenFromCookie(req) {
  return req.cookies?.[REFRESH_COOKIE] || null;
}

// Présence d'une autorité ambiante : c'est ce qui rend la requête sensible au CSRF.
function hasAuthCookie(req) {
  return Boolean(req.cookies?.[ACCESS_COOKIE] || req.cookies?.[REFRESH_COOKIE]);
}

module.exports = {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  CSRF_COOKIE,
  CSRF_HEADER,
  setAuthCookies,
  sendSessionResponse,
  clearAuthCookies,
  readAccessTokenFromCookie,
  readRefreshTokenFromCookie,
  hasAuthCookie,
};
