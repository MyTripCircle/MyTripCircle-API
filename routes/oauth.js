const express = require("express");
const jwt = require("jsonwebtoken");
const crypto = require("node:crypto");
const { getDb } = require("../db");
const { APPLE_APP_ID } = require("../config");
const { authLimiter } = require("../middleware/rateLimiter");
const { sanitizeUser, signAccessToken, createRefreshToken } = require("../utils/authHelpers");
const { hashField, encryptUserFields } = require("../utils/crypto");
const logger = require("../utils/logger");

const router = express.Router();

// ─── Apple JWKS ───────────────────────────────────────────────────────────────

let appleKeysCache = null;
let appleKeysCacheAt = 0;

async function getApplePublicKeys() {
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

// ─── Routes ───────────────────────────────────────────────────────────────────

// POST /users/google
router.post("/google", authLimiter, async (req, res) => {
  const { accessToken, mode = "register" } = req.body;
  if (!accessToken) return res.status(400).json({ success: false, error: "Missing accessToken" });

  try {
    const db = getDb();
    const googleRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!googleRes.ok) return res.status(401).json({ success: false, error: "Invalid Google token" });

    const { sub: googleId, email, name, picture } = await googleRes.json();
    if (!email) return res.status(400).json({ success: false, error: "No email returned from Google" });

    let user = await db.collection("users").findOne({ $or: [{ googleId }, { emailHash: hashField(email) }] });
    if (!user) {
      if (mode === "login") {
        return res.status(404).json({ success: false, error: "No Google account found. Please sign up first." });
      }
      const result = await db.collection("users").insertOne(
        encryptUserFields({
          name: name || email.split("@")[0],
          email,
          googleId,
          avatar: picture || null,
          verified: true,
          createdAt: new Date(),
        })
      );
      user = await db.collection("users").findOne({ _id: result.insertedId });
      const token = signAccessToken(user._id);
      const refreshToken = await createRefreshToken(db, user._id);
      return res.json({ success: true, token, refreshToken, user: sanitizeUser(user), isNewUser: true });
    } else if (!user.googleId) {
      await db.collection("users").updateOne({ _id: user._id }, { $set: { googleId } });
    }

    const token = signAccessToken(user._id);
    const refreshToken = await createRefreshToken(db, user._id);
    return res.json({ success: true, token, refreshToken, user: sanitizeUser(user), isNewUser: false });
  } catch (e) {
    logger.error("[auth/google] Erreur d'authentification", e.message);
    return res.status(500).json({ success: false, error: "Google authentication failed" });
  }
});

// POST /users/apple
router.post("/apple", authLimiter, async (req, res) => {
  const { identityToken, email, fullName, mode = "register" } = req.body;
  if (!identityToken) return res.status(400).json({ success: false, error: "Missing identityToken" });

  try {
    const db = getDb();

    let payload;
    try {
      payload = await verifyAppleToken(identityToken);
    } catch (e) {
      logger.error("[auth/apple] Vérification du token échouée", e.message);
      return res.status(401).json({ success: false, error: "Invalid Apple token" });
    }

    const { sub: appleId, email: tokenEmail } = payload;
    if (!appleId) return res.status(401).json({ success: false, error: "Invalid Apple token" });

    const userEmail = email || tokenEmail || null;
    const fallbackName = userEmail ? userEmail.split("@")[0] : "User";
    const userName = fullName
      ? `${fullName.givenName || ""} ${fullName.familyName || ""}`.trim()
      : fallbackName;

    let user = await db.collection("users").findOne({
      $or: [{ appleId }, ...(userEmail ? [{ emailHash: hashField(userEmail) }] : [])],
    });
    if (!user) {
      if (mode === "login") {
        return res.status(404).json({ success: false, error: "No Apple account found. Please sign up first." });
      }
      const result = await db.collection("users").insertOne(
        encryptUserFields({
          name: userName || "User",
          email: userEmail,
          appleId,
          verified: true,
          createdAt: new Date(),
        })
      );
      user = await db.collection("users").findOne({ _id: result.insertedId });
      const token = signAccessToken(user._id);
      const refreshToken = await createRefreshToken(db, user._id);
      return res.json({ success: true, token, refreshToken, user: sanitizeUser(user), isNewUser: true });
    } else if (!user.appleId) {
      await db.collection("users").updateOne({ _id: user._id }, { $set: { appleId } });
    }

    const token = signAccessToken(user._id);
    const refreshToken = await createRefreshToken(db, user._id);
    return res.json({ success: true, token, refreshToken, user: sanitizeUser(user), isNewUser: false });
  } catch (e) {
    logger.error("[auth/apple] Erreur d'authentification", e.message);
    return res.status(500).json({ success: false, error: "Apple authentication failed" });
  }
});

module.exports = router;
