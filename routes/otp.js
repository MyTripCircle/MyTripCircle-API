const express = require("express");
const bcrypt = require("bcrypt");
const crypto = require("node:crypto");
const logger = require("../utils/logger");
const { getDb } = require("../db");
const { authLimiter } = require("../middleware/rateLimiter");
const { sendPasswordResetEmail } = require("../utils/email");
const { hashField } = require("../utils/crypto");
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
    return res.json({ success: true, token: accessToken, refreshToken, user: sanitizeUser(user) });
  } catch (e) {

    logger.error("[otp]", e.message);

    return res.status(500).json({ success: false, error: "Erreur interne du serveur" });
  }
});

// GET /users/reset-password-page
router.get("/reset-password-page", async (req, res) => {
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
    const deepLink = `mytripcircle://reset-password?code=${safeCode}`;
    const escapedDeepLink = deepLink.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
    return res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Réinitialisation du mot de passe</title>
  <style>
    body { font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #F5F0E8; color: #2A2318; }
    h2 { font-size: 22px; margin-bottom: 12px; }
    p { color: #7A6A58; margin-bottom: 24px; text-align: center; max-width: 320px; }
    a { background: #C4714A; color: white; padding: 14px 28px; border-radius: 12px; text-decoration: none; font-size: 16px; }
  </style>
  <script>window.location.href = "${escapedDeepLink}";</script>
</head>
<body>
  <h2>MyTripCircle</h2>
  <p>Appuyez sur le bouton ci-dessous pour réinitialiser votre mot de passe dans l'app.</p>
  <a href="${escapedDeepLink}">Ouvrir l'application</a>
</body>
</html>`);
  } catch (e) {

    logger.error("[otp]", e.message);

    return res.status(500).send(errorPage("Une erreur est survenue. Réessayez."));
  }
});

module.exports = router;
