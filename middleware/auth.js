const jwt = require("jsonwebtoken");
const { ObjectId } = require("mongodb");
const { JWT_SECRET } = require("../config");
const { getDb } = require("../db");
const { decryptUserFields } = require("../utils/crypto");

async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return res.status(401).json({ success: false, error: "Non autorisé" });
    }

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    const userId = typeof decoded === "string" ? decoded : decoded.id;

    const user = await getDb()
      .collection("users")
      .findOne({ _id: new ObjectId(userId) });

    if (!user) {
      return res.status(401).json({ success: false, error: "Non autorisé" });
    }

    // Autoriser l'accès à cancel-deletion même si le compte est en attente de suppression
    const isCancelDeletion = req.path === "/me/cancel-deletion" && req.method === "POST";
    if (user.pendingDeletion && !isCancelDeletion) {
      return res.status(403).json({
        success: false,
        error: "Compte en cours de suppression",
        pendingDeletion: true,
        deletionScheduledAt: user.deletionScheduledAt,
      });
    }

    req.user = decryptUserFields(user);
    next();
  } catch {
    return res.status(401).json({ success: false, error: "Non autorisé" });
  }
}

module.exports = { requireAuth };
