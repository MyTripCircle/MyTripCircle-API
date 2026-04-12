const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const crypto = require("node:crypto");
const { JWT_SECRET, REFRESH_SECRET } = require("../config");
const { decrypt } = require("./crypto");

const OTP_EXPIRY_MS = 10 * 60 * 1000;

function trimIfString(v) {
  return typeof v === "string" ? v.trim() : v;
}

function isStrongPassword(password) {
  if (typeof password !== "string") return false;
  return /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/.test(password);
}

function sanitizeUser(doc) {
  if (!doc) return null;
  return {
    id: String(doc._id),
    name: doc.name ? decrypt(doc.name) : doc.name,
    email: doc.email ? decrypt(doc.email) : doc.email,
    phone: doc.phone ? decrypt(doc.phone) : doc.phone,
    avatar: doc.avatar,
    verified: doc.verified || false,
    createdAt: doc.createdAt,
    language: doc.language || "fr",
    isPublicProfile: doc.isPublicProfile === true,
  };
}

function signAccessToken(userId) {
  return jwt.sign({ id: String(userId) }, JWT_SECRET, { expiresIn: "15m" });
}

// Hash SHA-256 d'un refresh token avant stockage en base.
// Le token en clair n'est jamais persisté : seul le hash est stocké,
// ce qui limite l'exploitabilité en cas de compromission de la base.
function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function createRefreshToken(db, userId) {
  const token = jwt.sign({ id: String(userId) }, REFRESH_SECRET, { expiresIn: "7d" });
  await db.collection("refreshTokens").insertOne({
    token: hashToken(token),
    userId: String(userId),
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  });
  return token;
}

function generateOtp() {
  return crypto.randomInt(100000, 1000000).toString();
}

module.exports = {
  OTP_EXPIRY_MS,
  trimIfString,
  isStrongPassword,
  sanitizeUser,
  signAccessToken,
  createRefreshToken,
  hashToken,
  generateOtp,
};
