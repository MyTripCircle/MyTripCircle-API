const express = require("express");
const bcrypt = require("bcrypt");
const crypto = require("node:crypto");
const logger = require("../utils/logger");
const { getDb } = require("../db");
const { authLimiter } = require("../middleware/rateLimiter");
const { sendPasswordResetEmail } = require("../utils/email");
const { hashField } = require("../utils/crypto");
const { htmlPageCsp } = require("../middleware/htmlCsp");
const { sendSessionResponse } = require("../utils/authCookies");
const { buildWebAppUrl } = require("../utils/webRedirect");
const {
  OTP_EXPIRY_MS,
  trimIfString,
  isStrongPassword,
  sanitizeUser,
  signAccessToken,
  createRefreshToken,
} = require("../utils/authHelpers");

const router = express.Router();

function errorPage(message) {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Lien invalide</title>
  <style>
    body { font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #F5F0E8; color: #2A2318; }
    h2 { font-size: 22px; margin-bottom: 12px; }
    p { color: #7A6A58; text-align: center; max-width: 320px; }
    .icon { font-size: 52px; margin-bottom: 16px; }
  </style>
</head>
<body>
  <div class="icon">🔒</div>
  <h2>Lien invalide</h2>
  <p>${message}</p>
</body>
</html>`;
}

// POST /users/forgot-password
router.post("/forgot-password", authLimiter, async (req, res) => {
  try {
    const db = getDb();
    const email = trimIfString(req.body?.email)?.toLowerCase();

    if (!email) return res.status(400).json({ success: false, error: "Email requis" });

    const user = await db.collection("users").findOne({ emailHash: hashField(email) });
    // Réponse identique que l'utilisateur existe ou non (anti-énumération d'emails)
    if (!user) {
      return res.json({ success: true, message: "Si un compte existe, un lien a été envoyé" });
    }

    const resetToken = crypto.randomBytes(32).toString("hex");
    await db.collection("users").updateOne(
      { _id: user._id },
      { $set: { resetToken, resetTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000), updatedAt: new Date() } }
    );

    await sendPasswordResetEmail(email, resetToken);
    return res.json({ success: true, message: "Si un compte existe, un lien a été envoyé" });
  } catch (e) {

    logger.error("[otp]", e.message);

    return res.status(500).json({ success: false, error: "Erreur interne du serveur" });
  }
});

// GET /users/verify-reset-token
router.get("/verify-reset-token", async (req, res) => {
  try {
    const db = getDb();
    const { code } = req.query;

    if (!code) return res.status(400).json({ success: false, error: "Code manquant" });

    const user = await db.collection("users").findOne({
      resetCode: code,
      resetCodeExpiresAt: { $gt: new Date() },
    });

    if (!user) return res.status(400).json({ success: false, error: "Lien invalide ou déjà utilisé" });
    return res.json({ success: true });
  } catch (e) {

    logger.error("[otp]", e.message);

    return res.status(500).json({ success: false, error: "Erreur interne du serveur" });
  }
});

// POST /users/reset-password
router.post("/reset-password", authLimiter, async (req, res) => {
  try {
    const db = getDb();
    const { code, newPassword } = req.body;

    if (!code || !newPassword) {
      return res.status(400).json({ success: false, error: "Code et nouveau mot de passe requis" });
    }

    if (!isStrongPassword(newPassword)) {
      return res.status(400).json({ success: false, error: "Mot de passe trop faible", field: "password" });
    }

    const user = await db.collection("users").findOne({
      resetCode: code,
      resetCodeExpiresAt: { $gt: new Date() },
    });

    if (!user) return res.status(400).json({ success: false, error: "Code invalide ou expiré" });

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await db.collection("users").updateOne(
      { _id: user._id },
      {
        $set: { password: passwordHash, updatedAt: new Date() },
        $unset: { resetCode: "", resetCodeExpiresAt: "", passwordHash: "" },
      }
    );

    const accessToken = signAccessToken(user._id);
    const refreshToken = await createRefreshToken(db, user._id);
    return sendSessionResponse(res, {
      accessToken,
      refreshToken,
      extra: { user: sanitizeUser(user) },
    });
  } catch (e) {

    logger.error("[otp]", e.message);

    return res.status(500).json({ success: false, error: "Erreur interne du serveur" });
  }
});

function escapeHtmlAttr(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

/**
 * Page-relais du lien reçu par email : rebondit vers l'app web quand elle est
 * configurée (WEB_APP_URL), sinon vers le schéma de l'app mobile — comportement
 * historique conservé pour les déploiements sans front web.
 * Le script inline est autorisé par le nonce posé par htmlPageCsp.
 */
function resetRedirectPage({ nonce, appLink, webLink }) {
  const target = escapeHtmlAttr(webLink || appLink);
  const appHref = escapeHtmlAttr(appLink);
  const webButton = webLink
    ? `<a class="secondary" href="${escapeHtmlAttr(webLink)}">Continuer dans le navigateur</a>`
    : "";

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Réinitialisation du mot de passe</title>
  <style>
    body { font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #F5F0E8; color: #2A2318; }
    h2 { font-size: 22px; margin-bottom: 12px; }
    p { color: #7A6A58; margin-bottom: 24px; text-align: center; max-width: 320px; }
    a { background: #C4714A; color: white; padding: 14px 28px; border-radius: 12px; text-decoration: none; font-size: 16px; margin-bottom: 12px; }
    a.secondary { background: transparent; color: #C4714A; }
  </style>
  <script nonce="${nonce}">window.location.href = "${target}";</script>
</head>
<body>
  <h2>MyTripCircle</h2>
  <p>Appuyez sur le bouton ci-dessous pour réinitialiser votre mot de passe.</p>
  <a href="${appHref}">Ouvrir l'application</a>
  ${webButton}
</body>
</html>`;
}

// GET /users/reset-password-page
router.get("/reset-password-page", htmlPageCsp, async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send(errorPage("Token manquant."));

  try {
    const db = getDb();
    const user = await db.collection("users").findOne({
      resetToken: token,
      resetTokenExpiresAt: { $gt: new Date() },
    });

    if (!user) return res.status(400).send(errorPage("Ce lien est invalide ou a déjà été utilisé."));

    const resetCode = crypto.randomBytes(16).toString("hex");
    await db.collection("users").updateOne(
      { _id: user._id },
      {
        $set: { resetCode, resetCodeExpiresAt: new Date(Date.now() + OTP_EXPIRY_MS) },
        $unset: { resetToken: "", resetTokenExpiresAt: "" },
      }
    );

    // Le resetCode est généré par crypto.randomBytes (hex uniquement) — encodage par précaution
    const safeCode = encodeURIComponent(resetCode);
    return res.send(
      resetRedirectPage({
        nonce: res.locals.cspNonce,
        appLink: `mytripcircle://reset-password?code=${safeCode}`,
        webLink: buildWebAppUrl("/reset-password", { code: resetCode }),
      })
    );
  } catch (e) {

    logger.error("[otp]", e.message);

    return res.status(500).send(errorPage("Une erreur est survenue. Réessayez."));
  }
});

module.exports = router;
