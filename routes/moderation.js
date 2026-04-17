const express = require("express");
const { ObjectId } = require("mongodb");
const { getDb } = require("../db");
const { requireAuth } = require("../middleware/auth");
const logger = require("../utils/logger");

const router = express.Router();

const VALID_REASONS = ["inappropriate", "spam", "harassment", "fake", "other"];

// POST /moderation/report — signaler un utilisateur ou un voyage
router.post("/report", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const reporterId = String(req.user._id);
    const { targetType, targetId, reason, details } = req.body;

    if (!["user", "trip"].includes(targetType)) {
      return res.status(400).json({ success: false, error: "targetType invalide" });
    }
    if (!targetId || typeof targetId !== "string") {
      return res.status(400).json({ success: false, error: "targetId requis" });
    }
    if (!VALID_REASONS.includes(reason)) {
      return res.status(400).json({ success: false, error: "Raison invalide" });
    }
    if (targetType === "user" && targetId === reporterId) {
      return res.status(400).json({ success: false, error: "Impossible de se signaler soi-même" });
    }

    await db.collection("reports").insertOne({
      reporterId,
      targetType,
      targetId,
      reason,
      details: typeof details === "string" ? details.slice(0, 500) : null,
      status: "pending",
      createdAt: new Date(),
    });

    return res.json({ success: true });
  } catch (e) {
    logger.error("[moderation] report", e.message);
    return res.status(500).json({ success: false, error: "Erreur interne du serveur" });
  }
});

// POST /moderation/block/:userId — bloquer un utilisateur
router.post("/block/:userId", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const blockerId = String(req.user._id);
    const blockedId = req.params.userId;

    if (blockerId === blockedId) {
      return res.status(400).json({ success: false, error: "Impossible de se bloquer soi-même" });
    }

    await db.collection("blocks").updateOne(
      { blockerId, blockedId },
      { $setOnInsert: { blockerId, blockedId, createdAt: new Date() } },
      { upsert: true }
    );

    return res.json({ success: true });
  } catch (e) {
    logger.error("[moderation] block", e.message);
    return res.status(500).json({ success: false, error: "Erreur interne du serveur" });
  }
});

// DELETE /moderation/block/:userId — débloquer un utilisateur
router.delete("/block/:userId", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const blockerId = String(req.user._id);
    const blockedId = req.params.userId;

    await db.collection("blocks").deleteOne({ blockerId, blockedId });

    return res.json({ success: true });
  } catch (e) {
    logger.error("[moderation] unblock", e.message);
    return res.status(500).json({ success: false, error: "Erreur interne du serveur" });
  }
});

module.exports = router;
