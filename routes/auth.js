const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const logger = require("../utils/logger");
const { ObjectId } = require("mongodb");
const { getDb } = require("../db");
const { REFRESH_SECRET } = require("../config");
const { sendOtpEmail } = require("../utils/email");
const { authLimiter } = require("../middleware/rateLimiter");
const { linkPendingFriendRequests } = require("./friends");
const { isValidEmail, isValidPhone } = require("../utils/validators");
const {
  OTP_EXPIRY_MS,
  trimIfString,
  isStrongPassword,
  sanitizeUser,
  signAccessToken,
  createRefreshToken,
  hashToken,
  generateOtp,
} = require("../utils/authHelpers");
const { hashField, encryptUserFields, decrypt } = require("../utils/crypto");

const router = express.Router();

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
      if (!isValidPhone(phone)) {
        return res.status(400).json({ success: false, error: "Numéro de téléphone invalide", field: "phone" });
      }
      const existingPhone = await db.collection("users").findOne({ phoneHash: hashField(phone), verified: true });
      if (existingPhone) {
        return res.status(409).json({ success: false, error: "Numéro de téléphone déjà utilisé", field: "phone" });
      }
    }

    const existing = await db.collection("users").findOne({ emailHash: hashField(email) });
    if (existing) {
      if (!existing.verified) {
        const otp = generateOtp();
        await db.collection("users").updateOne(
          { _id: existing._id },
          { $set: { otp, otpExpiresAt: new Date(Date.now() + OTP_EXPIRY_MS), updatedAt: new Date() } }
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

    const result = await db.collection("users").insertOne(
      encryptUserFields({
        name,
        email,
        password: passwordHash,
        phone,
        otp,
        otpExpiresAt: new Date(Date.now() + OTP_EXPIRY_MS),
        verified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
    );

    await sendOtpEmail(email, otp);
    return res.status(201).json({ success: true, userId: String(result.insertedId), message: "Code envoyé par email" });
  } catch (e) {

    logger.error("[auth]", e.message);

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

    const user = await db.collection("users").findOne({ emailHash: hashField(email) });
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
        { $set: { otp: newOtp, otpExpiresAt: new Date(Date.now() + OTP_EXPIRY_MS) } }
      );
      await sendOtpEmail(decrypt(user.email), newOtp);
      return res.status(403).json({
        success: false,
        error: "Code expiré. Un nouveau code a été envoyé.",
        requiresOtp: true,
        userId: String(user._id),
      });
    }

    const accessToken = signAccessToken(user._id);
    const refreshToken = await createRefreshToken(db, user._id);
    return res.json({ success: true, token: accessToken, refreshToken, user: sanitizeUser(user) });
  } catch (e) {

    logger.error("[auth]", e.message);

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

    await linkPendingFriendRequests(userId, decrypt(user.email), user.phone ? decrypt(user.phone) : null);

    const updatedUser = await db.collection("users").findOne({ _id: new ObjectId(userId) });
    const accessToken = signAccessToken(userId);
    const refreshToken = await createRefreshToken(db, userId);
    return res.json({ success: true, token: accessToken, refreshToken, user: sanitizeUser(updatedUser) });
  } catch (e) {

    logger.error("[auth]", e.message);

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
      { $set: { otp, otpExpiresAt: new Date(Date.now() + OTP_EXPIRY_MS), updatedAt: new Date() } }
    );

    await sendOtpEmail(decrypt(user.email), otp);
    return res.json({ success: true, message: "Code renvoyé" });
  } catch (e) {

    logger.error("[auth]", e.message);

    return res.status(500).json({ success: false, error: "Erreur interne du serveur" });
  }
});

// POST /users/refresh
router.post("/refresh", async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ success: false, error: "refreshToken requis" });

  try {
    const payload = jwt.verify(refreshToken, REFRESH_SECRET);
    const db = getDb();

    const stored = await db.collection("refreshTokens").findOne({ token: hashToken(refreshToken) });
    if (!stored) return res.status(401).json({ success: false, error: "Token invalide ou révoqué" });

    // Rotation : supprime l'ancien refresh token et en crée un nouveau
    await db.collection("refreshTokens").deleteOne({ token: hashToken(refreshToken) });
    const newRefreshToken = await createRefreshToken(db, payload.id);

    const token = signAccessToken(payload.id);
    return res.json({ success: true, token, refreshToken: newRefreshToken });
  } catch {
    return res.status(401).json({ success: false, error: "Token invalide ou expiré" });
  }
});

// POST /users/logout
router.post("/logout", async (req, res) => {
  const { refreshToken } = req.body;
  if (refreshToken) {
    try {
      const db = getDb();
      await db.collection("refreshTokens").deleteOne({ token: hashToken(refreshToken) });
    } catch {
      // Silencieux : on déconnecte quoi qu'il arrive
    }
  }
  return res.json({ success: true });
});

module.exports = { router, sanitizeUser, isStrongPassword, trimIfString, signAccessToken };
