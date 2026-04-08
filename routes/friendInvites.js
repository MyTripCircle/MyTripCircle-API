const express = require("express");
const crypto = require("crypto");
const { ObjectId } = require("mongodb");
const { getDb } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { sendFriendJoinedEmail } = require("../utils/email");

const router = express.Router();

// POST /friends/invite-link
router.post("/invite-link", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const userId = String(req.user._id);

    const existing = await db.collection("friendInviteLinks").findOne({ userId });
    if (existing) {
      return res.json({ token: existing.token, link: `mytripcircle://friend-invite/${existing.token}` });
    }

    const token = crypto.randomBytes(32).toString("hex");
    await db.collection("friendInviteLinks").insertOne({ userId, token, createdAt: new Date() });

    return res.json({ token, link: `mytripcircle://friend-invite/${token}` });
  } catch (e) {
    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// GET /friends/invite-link/:token
router.get("/invite-link/:token", async (req, res) => {
  try {
    const db = getDb();
    const link = await db.collection("friendInviteLinks").findOne({ token: req.params.token });
    if (!link) return res.status(404).json({ error: "Lien introuvable" });

    const owner = await db.collection("users").findOne({ _id: new ObjectId(link.userId) });
    if (!owner) return res.status(404).json({ error: "Utilisateur introuvable" });

    return res.json({ userId: String(owner._id), name: owner.name, avatar: owner.avatar || null });
  } catch (e) {
    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// POST /friends/invite-link/:token/accept
router.post("/invite-link/:token/accept", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const { token } = req.params;
    const currentUserId = String(req.user._id);

    const link = await db.collection("friendInviteLinks").findOne({ token });
    if (!link) return res.status(404).json({ error: "Lien introuvable" });

    const ownerId = link.userId;
    if (ownerId === currentUserId) return res.status(400).json({ error: "Impossible de s'ajouter soi-même" });

    const existingFriendship = await db.collection("friends").findOne({
      $or: [{ userId: currentUserId, friendId: ownerId }, { userId: ownerId, friendId: currentUserId }],
    });
    if (existingFriendship) return res.status(400).json({ error: "Déjà amis" });

    const owner = await db.collection("users").findOne({ _id: new ObjectId(ownerId) });
    if (!owner) return res.status(404).json({ error: "Utilisateur introuvable" });

    const now = new Date();
    const currentUser = req.user;

    const existingRequest = await db.collection("friendRequests").findOne({
      $or: [
        { senderId: currentUserId, recipientId: ownerId, status: "pending" },
        { senderId: ownerId, recipientId: currentUserId, status: "pending" },
      ],
    });

    if (existingRequest) {
      await db.collection("friendRequests").updateOne(
        { _id: existingRequest._id },
        { $set: { status: "accepted", respondedAt: now } }
      );
    } else {
      await db.collection("friendRequests").insertOne({
        senderId: currentUserId,
        senderName: currentUser.name,
        recipientId: ownerId,
        recipientEmail: owner.email,
        status: "accepted",
        createdAt: now,
        respondedAt: now,
      });
    }

    await db.collection("friends").insertMany([
      { userId: currentUserId, friendId: ownerId, name: owner.name, email: owner.email, phone: owner.phone || null, avatar: owner.avatar || null, createdAt: now },
      { userId: ownerId, friendId: currentUserId, name: currentUser.name, email: currentUser.email, phone: currentUser.phone || null, avatar: currentUser.avatar || null, createdAt: now },
    ]);

    await sendFriendJoinedEmail(owner.email, currentUser.name);

    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

module.exports = router;
