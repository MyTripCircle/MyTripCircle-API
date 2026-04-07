const jwt = require("jsonwebtoken");
const { ObjectId } = require("mongodb");
const { JWT_SECRET } = require("../config");
const { getDb } = require("../db");

async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
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

    req.user = user;
    next();
  } catch {
    return res.status(401).json({ success: false, error: "Non autorisé" });
  }
}

module.exports = { requireAuth };
