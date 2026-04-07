const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { ObjectId } = require("mongodb");
const { getDb } = require("../db");
const { JWT_SECRET, API_BASE_URL, APPLE_APP_ID } = require("../config");
const {
  sendOtpEmail,
  sendPasswordResetEmail,
} = require("../utils/email");
const { authLimiter } = require("../middleware/rateLimiter");
const { linkPendingFriendRequests } = require("./friends");

const router = express.Router();

function trimIfString(v) {
  return typeof v === "string" ? v.trim() : v;
}

function isValidEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

function isStrongPassword(password) {
  if (typeof password !== "string") return false;
  return /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/.test(password);
}

// Cache des clés publiques Apple (JWKS)
let appleKeysCache = null;
let appleKeysCacheAt = 0;

async function getApplePublicKeys() {
  // Rafraîchit le cache toutes les heures
  if (appleKeysCache && Date.now() - appleKeysCacheAt < 60 * 60 * 1000) {
    return appleKeysCache;
  }
  const res = await fetch("https://appleid.apple.com/auth/keys");
  if (!res.ok) throw new Error("Impossible de récupérer les clés Apple");
  const { keys } = await res.json();
  appleKeysCache = keys;
  appleKeysCacheAt = Date.now();
  return keys;
}

async function verifyAppleToken(identityToken) {
  const parts = identityToken.split(".");
  if (parts.length !== 3) throw new Error("Format de token Apple invalide");

  const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  const keys = await getApplePublicKeys();
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("Clé publique Apple introuvable");

  const publicKey = crypto.createPublicKey({ key: jwk, format: "jwk" });
  const pem = publicKey.export({ type: "spki", format: "pem" });

  const verifyOptions = { algorithms: ["RS256"] };
  if (APPLE_APP_ID) verifyOptions.audience = APPLE_APP_ID;

  return jwt.verify(identityToken, pem, verifyOptions);
}

function sanitizeUser(doc) {
  if (!doc) return null;
  return {
    id: String(doc._id),
    name: doc.name,
    email: doc.email,
    phone: doc.phone,
    avatar: doc.avatar,
    verified: doc.verified || false,
    createdAt: doc.createdAt,
    language: doc.language || "fr",
    isPublicProfile: doc.isPublicProfile === true,
  };
}

function signToken(userId, expiresIn = "7d") {
  return jwt.sign({ id: String(userId) }, JWT_SECRET, { expiresIn });
}

function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// POST /users/register
router.post("/register", authLimiter, async (req, res) => {
  try {
    const db = getDb();
    const name = trimIfString(req.body?.name);
    const email = trimIfString(req.body?.email)?.toLowerCase();
    const password = req.body?.password;
    const phone = trimIfString(req.body?.phone);

    if (!name || !email || !password) {
      return res.status(400).json({ success: false, error: "Champs requis manquants" });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ success: false, error: "Email invalide", field: "email" });
    }

    if (!isStrongPassword(password)) {
      return res.status(400).json({ success: false, error: "Mot de passe trop faible", field: "password" });
    }

    if (phone) {
      if (!/^[+]?[\d\s().-]{7,20}$/.test(phone)) {
        return res.status(400).json({ success: false, error: "Numéro de téléphone invalide", field: "phone" });
      }
      const existingPhone = await db.collection("users").findOne({ phone, verified: true });
      if (existingPhone) {
        return res.status(409).json({ success: false, error: "Numéro de téléphone déjà utilisé", field: "phone" });
      }
    }

    const existing = await db.collection("users").findOne({ email });
    if (existing) {
      if (!existing.verified) {
        const otp = generateOtp();
        await db.collection("users").updateOne(
          { _id: existing._id },
          { $set: { otp, otpExpiresAt: new Date(Date.now() + 10 * 60 * 1000), updatedAt: new Date() } }
        );
        await sendOtpEmail(email, otp);
        return res.status(200).json({
          success: false,
          requiresOtp: true,
          userId: String(existing._id),
          error: "Compte non vérifié. Un nouveau code a été envoyé.",
        });
      }
      return res.status(409).json({ success: false, error: "Email déjà utilisé", field: "email" });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const otp = generateOtp();

    const result = await db.collection("users").insertOne({
      name,
      email,
      password: passwordHash,
      phone,
      otp,
      otpExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
      verified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await sendOtpEmail(email, otp);

    return res.status(201).json({ success: true, userId: String(result.insertedId), message: "Code envoyé par email" });
  } catch (e) {
    return res.status(500).json({ success: false, error: "Erreur interne du serveur" });
  }
});

// POST /users/login
router.post("/login", authLimiter, async (req, res) => {
  try {
    const db = getDb();
    const email = trimIfString(req.body?.email)?.toLowerCase();
    const password = req.body?.password;

    if (!email || !password) {
      return res.status(400).json({ success: false, error: "Champs requis manquants" });
    }

    if (!isValidEmail(email)) {
      return res.status(401).json({ success: false, error: "Identifiants invalides", field: "password" });
    }

    const user = await db.collection("users").findOne({ email });
    if (!user) {
      return res.status(401).json({ success: false, error: "Identifiants invalides", field: "password" });
    }

    const storedHash = user.passwordHash || user.password;
    if (!storedHash || !(await bcrypt.compare(password, storedHash))) {
      return res.status(401).json({ success: false, error: "Identifiants invalides", field: "password" });
    }

    if (!user.verified) {
      if (user.otp && user.otpExpiresAt && new Date() < new Date(user.otpExpiresAt)) {
        return res.status(403).json({
          success: false,
          error: "Vérifiez votre compte avec le code envoyé par email",
          requiresOtp: true,
          userId: String(user._id),
        });
      }
      const newOtp = generateOtp();
      await db.collection("users").updateOne(
        { _id: user._id },
        { $set: { otp: newOtp, otpExpiresAt: new Date(Date.now() + 10 * 60 * 1000) } }
      );
      await sendOtpEmail(user.email, newOtp);
      return res.status(403).json({
        success: false,
        error: "Code expiré. Un nouveau code a été envoyé.",
        requiresOtp: true,
        userId: String(user._id),
      });
    }

    return res.json({ success: true, token: signToken(user._id), user: sanitizeUser(user) });
  } catch (e) {
    return res.status(500).json({ success: false, error: "Erreur interne du serveur" });
  }
});

// POST /users/verify-otp
router.post("/verify-otp", authLimiter, async (req, res) => {
  try {
    const db = getDb();
    const { userId, otp } = req.body;

    if (!userId || !otp) {
      return res.status(400).json({ success: false, error: "userId et otp sont requis" });
    }

    const user = await db.collection("users").findOne({ _id: new ObjectId(userId) });
    if (!user) return res.status(404).json({ success: false, error: "Utilisateur introuvable" });

    if (!user.otp || user.otp !== otp) {
      return res.status(400).json({ success: false, error: "Code invalide" });
    }

    if (user.otpExpiresAt && new Date() > new Date(user.otpExpiresAt)) {
      return res.status(400).json({ success: false, error: "Code expiré" });
    }

    await db.collection("users").updateOne(
      { _id: new ObjectId(userId) },
      { $set: { verified: true, updatedAt: new Date() }, $unset: { otp: "", otpExpiresAt: "" } }
    );

    await linkPendingFriendRequests(userId, user.email, user.phone);

    const updatedUser = await db.collection("users").findOne({ _id: new ObjectId(userId) });
    return res.json({ success: true, token: signToken(userId), user: sanitizeUser(updatedUser) });
  } catch (e) {
    return res.status(500).json({ success: false, error: "Erreur interne du serveur" });
  }
});

// POST /users/resend-otp
router.post("/resend-otp", authLimiter, async (req, res) => {
  try {
    const db = getDb();
    const { userId } = req.body;

    if (!userId) return res.status(400).json({ success: false, error: "userId est requis" });

    const user = await db.collection("users").findOne({ _id: new ObjectId(userId) });
    if (!user) return res.status(404).json({ success: false, error: "Utilisateur introuvable" });
    if (user.verified) return res.status(400).json({ success: false, error: "Compte déjà vérifié" });

    const otp = generateOtp();
    await db.collection("users").updateOne(
      { _id: user._id },
      { $set: { otp, otpExpiresAt: new Date(Date.now() + 10 * 60 * 1000), updatedAt: new Date() } }
    );

    await sendOtpEmail(user.email, otp);
    return res.json({ success: true, message: "Code renvoyé" });
  } catch (e) {
    return res.status(500).json({ success: false, error: "Erreur interne du serveur" });
  }
});

// POST /users/forgot-password
router.post("/forgot-password", authLimiter, async (req, res) => {
  try {
    const db = getDb();
    const email = trimIfString(req.body?.email)?.toLowerCase();

    if (!email) return res.status(400).json({ success: false, error: "Email requis" });

    const user = await db.collection("users").findOne({ email });
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
    return res.status(500).json({ success: false, error: "Erreur interne du serveur" });
  }
});

// GET /users/verify-reset-token
router.get("/verify-reset-token", async (req, res) => {
  try {
    const db = getDb();
    const { token } = req.query;

    if (!token) return res.status(400).json({ success: false, error: "Token manquant" });

    const user = await db.collection("users").findOne({
      resetToken: token,
      resetTokenExpiresAt: { $gt: new Date() },
    });

    if (!user) return res.status(400).json({ success: false, error: "Lien invalide ou déjà utilisé" });
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: "Erreur interne du serveur" });
  }
});

// POST /users/reset-password
router.post("/reset-password", authLimiter, async (req, res) => {
  try {
    const db = getDb();
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      return res.status(400).json({ success: false, error: "Token et nouveau mot de passe requis" });
    }

    if (!isStrongPassword(newPassword)) {
      return res.status(400).json({ success: false, error: "Mot de passe trop faible", field: "password" });
    }

    const user = await db.collection("users").findOne({
      resetToken: token,
      resetTokenExpiresAt: { $gt: new Date() },
    });

    if (!user) return res.status(400).json({ success: false, error: "Token invalide ou expiré" });

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await db.collection("users").updateOne(
      { _id: user._id },
      {
        $set: { password: passwordHash, updatedAt: new Date() },
        $unset: { resetToken: "", resetTokenExpiresAt: "", passwordHash: "" },
      }
    );

    return res.json({ success: true, token: signToken(user._id, "30d"), user: sanitizeUser(user) });
  } catch (e) {
    return res.status(500).json({ success: false, error: "Erreur interne du serveur" });
  }
});

// POST /users/google
router.post("/google", authLimiter, async (req, res) => {
  const { accessToken } = req.body;
  if (!accessToken) return res.status(400).json({ success: false, error: "accessToken manquant" });

  try {
    const db = getDb();
    const googleRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!googleRes.ok) return res.status(401).json({ success: false, error: "Token Google invalide" });

    const { sub: googleId, email, name, picture } = await googleRes.json();
    if (!email) return res.status(400).json({ success: false, error: "Aucun email retourné par Google" });

    let user = await db.collection("users").findOne({ $or: [{ googleId }, { email }] });
    if (!user) {
      const result = await db.collection("users").insertOne({
        name: name || email.split("@")[0],
        email,
        googleId,
        avatar: picture || null,
        verified: true,
        createdAt: new Date(),
      });
      user = await db.collection("users").findOne({ _id: result.insertedId });
    } else if (!user.googleId) {
      await db.collection("users").updateOne({ _id: user._id }, { $set: { googleId } });
    }

    return res.json({ success: true, token: signToken(user._id, "30d"), user: sanitizeUser(user) });
  } catch (e) {
    console.error("[auth/google]", e.message);
    return res.status(500).json({ success: false, error: "Authentification Google échouée" });
  }
});

// POST /users/apple
router.post("/apple", authLimiter, async (req, res) => {
  const { identityToken, email, fullName } = req.body;
  if (!identityToken) return res.status(400).json({ success: false, error: "identityToken manquant" });

  try {
    const db = getDb();

    // Vérification cryptographique du token Apple via JWKS
    let payload;
    try {
      payload = await verifyAppleToken(identityToken);
    } catch (e) {
      console.error("[auth/apple] Vérification token échouée :", e.message);
      return res.status(401).json({ success: false, error: "Token Apple invalide" });
    }

    const { sub: appleId, email: tokenEmail } = payload;
    if (!appleId) return res.status(401).json({ success: false, error: "Token Apple invalide" });

    const userEmail = email || tokenEmail || null;
    const userName = fullName
      ? `${fullName.givenName || ""} ${fullName.familyName || ""}`.trim()
      : (userEmail ? userEmail.split("@")[0] : "User");

    let user = await db.collection("users").findOne({
      $or: [{ appleId }, ...(userEmail ? [{ email: userEmail }] : [])],
    });
    if (!user) {
      const result = await db.collection("users").insertOne({
        name: userName || "User",
        email: userEmail,
        appleId,
        verified: true,
        createdAt: new Date(),
      });
      user = await db.collection("users").findOne({ _id: result.insertedId });
    } else if (!user.appleId) {
      await db.collection("users").updateOne({ _id: user._id }, { $set: { appleId } });
    }

    return res.json({ success: true, token: signToken(user._id, "30d"), user: sanitizeUser(user) });
  } catch (e) {
    console.error("[auth/apple]", e.message);
    return res.status(500).json({ success: false, error: "Authentification Apple échouée" });
  }
});

// Page HTML de reset de mot de passe (deep link → app)
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

    const deepLink = `mytripcircle://reset-password?token=${token}`;
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
  <script>window.location.href = "${deepLink}";</script>
</head>
<body>
  <h2>MyTripCircle</h2>
  <p>Appuyez sur le bouton ci-dessous pour réinitialiser votre mot de passe dans l'app.</p>
  <a href="${deepLink}">Ouvrir l'application</a>
</body>
</html>`);
  } catch (e) {
    return res.status(500).send(errorPage("Une erreur est survenue. Réessayez."));
  }
});

module.exports = { router, sanitizeUser, isStrongPassword, trimIfString, signToken };
