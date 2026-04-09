const express = require("express");
const logger = require("../utils/logger");
const { ObjectId } = require("mongodb");
const { getDb } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { sendFriendRequestEmail } = require("../utils/email");

const router = express.Router();

async function checkRegisteredRecipient(db, senderId, sender, recipientUser) {
  const recipientId = String(recipientUser._id);

  const existingFriendship = await db.collection("friends").findOne({
    $or: [{ userId: senderId, friendId: recipientId }, { userId: recipientId, friendId: senderId }],
  });
  if (existingFriendship) return { error: "Déjà amis", status: 400 };

  const incomingRequest = await db.collection("friendRequests").findOne({
    senderId: recipientId, recipientId: senderId, status: "pending",
  });
  if (incomingRequest) {
    const now = new Date();
    await db.collection("friendRequests").updateOne(
      { _id: incomingRequest._id },
      { $set: { status: "accepted", respondedAt: now } }
    );
    await db.collection("friends").insertMany([
      { userId: senderId, friendId: recipientId, name: recipientUser.name, email: recipientUser.email, phone: recipientUser.phone, createdAt: now },
      { userId: recipientId, friendId: senderId, name: sender?.name || "Quelqu'un", email: sender?.email, phone: sender?.phone, createdAt: now },
    ]);
    return { autoAccepted: true };
  }

  const existingRequest = await db.collection("friendRequests").findOne({ senderId, recipientId, status: "pending" });
  if (existingRequest) return { error: "Demande déjà en attente", status: 400 };

  return { ok: true };
}

function isSelf(senderId, sender, recipientIdParam, recipientEmail, recipientPhone) {
  if (recipientIdParam === senderId) return true;
  if (recipientEmail && sender?.email && recipientEmail.toLowerCase() === sender.email.toLowerCase()) return true;
  if (recipientPhone && sender?.phone && recipientPhone === sender.phone) return true;
  return false;
}

async function findRecipientUser(db, recipientIdParam, recipientEmail, recipientPhone) {
  if (recipientIdParam) return db.collection("users").findOne({ _id: new ObjectId(recipientIdParam) });
  const byEmail = recipientEmail && await db.collection("users").findOne({ email: recipientEmail });
  if (byEmail) return byEmail;
  return recipientPhone ? db.collection("users").findOne({ phone: recipientPhone }) : null;
}

async function checkUnregisteredDuplicate(db, senderId, recipientEmail, recipientPhone) {
  const query = { senderId, recipientId: null, status: "pending" };
  if (recipientEmail) query.recipientEmail = recipientEmail;
  if (recipientPhone) query.recipientPhone = recipientPhone;
  const existingRequest = await db.collection("friendRequests").findOne(query);
  return existingRequest ? "Demande déjà en attente" : null;
}

// POST /friends/request
router.post("/request", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const senderId = String(req.user._id);
    const { recipientEmail, recipientPhone, recipientId: recipientIdParam } = req.body;

    if (!recipientEmail && !recipientPhone && !recipientIdParam) {
      return res.status(400).json({ error: "Email, téléphone ou ID requis" });
    }

    const sender = await db.collection("users").findOne({ _id: new ObjectId(senderId) });

    if (isSelf(senderId, sender, recipientIdParam, recipientEmail, recipientPhone)) {
      return res.status(400).json({ error: "Impossible de s'envoyer une demande à soi-même" });
    }

    const recipientUser = await findRecipientUser(db, recipientIdParam, recipientEmail, recipientPhone);

    if (recipientUser && String(recipientUser._id) === senderId) {
      return res.status(400).json({ error: "Impossible de s'envoyer une demande à soi-même" });
    }

    if (recipientUser) {
      const check = await checkRegisteredRecipient(db, senderId, sender, recipientUser);
      if (check.error) return res.status(check.status).json({ error: check.error });
      if (check.autoAccepted) return res.json({ success: true, autoAccepted: true });
    } else {
      const dupError = await checkUnregisteredDuplicate(db, senderId, recipientEmail, recipientPhone);
      if (dupError) return res.status(400).json({ error: dupError });
    }

    const friendRequest = {
      senderId,
      senderName: sender?.name || "Quelqu'un",
      recipientId: recipientUser ? String(recipientUser._id) : null,
      recipientEmail,
      recipientPhone,
      status: "pending",
      createdAt: new Date(),
    };

    const result = await db.collection("friendRequests").insertOne(friendRequest);
    friendRequest._id = result.insertedId;

    if (recipientUser) {
      await sendFriendRequestEmail(recipientUser.email, sender?.name || "Quelqu'un", recipientUser.language || "fr");
    }

    return res.json(friendRequest);
  } catch (e) {

    logger.error("[friendRequests]", e.message);

    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// GET /friends/requests
router.get("/requests", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const userId = String(req.user._id);

    const [received, sent] = await Promise.all([
      db.collection("friendRequests").find({ recipientId: userId, status: "pending" }).sort({ createdAt: -1 }).toArray(),
      db.collection("friendRequests").find({ senderId: userId, status: "pending" }).sort({ createdAt: -1 }).toArray(),
    ]);

    const seenIds = new Set();
    const all = [...received, ...sent].filter((r) => {
      const id = r._id.toString();
      if (seenIds.has(id)) return false;
      seenIds.add(id);
      return true;
    });

    const myFriendDocs = await db.collection("friends").find({ userId }).toArray();
    const myFriendIds = new Set(myFriendDocs.map((f) => f.friendId));

    const commonFriendsMap = {};
    if (received.length > 0) {
      const senderIdList = received.map((r) => r.senderId).filter(Boolean);
      const senderFriendDocs = await db.collection("friends").find({ userId: { $in: senderIdList } }).toArray();
      const senderFriendsByUser = {};
      senderFriendDocs.forEach((f) => {
        if (!senderFriendsByUser[f.userId]) senderFriendsByUser[f.userId] = [];
        senderFriendsByUser[f.userId].push(f.friendId);
      });
      received.forEach((r) => {
        const sf = senderFriendsByUser[r.senderId] || [];
        commonFriendsMap[r._id.toString()] = sf.filter((id) => myFriendIds.has(id)).length;
      });
    }

    const recipientNameMap = {};
    if (sent.length > 0) {
      const recipientIdList = sent.map((r) => r.recipientId).filter(Boolean);
      if (recipientIdList.length > 0) {
        const recipientUsers = await db.collection("users").find({
          _id: { $in: recipientIdList.map((id) => { try { return new ObjectId(id); } catch { return null; } }).filter(Boolean) },
        }).project({ _id: 1, name: 1 }).toArray();
        recipientUsers.forEach((u) => { recipientNameMap[String(u._id)] = u.name || null; });
      }
    }

    return res.json(all.map((r) => ({
      id: r._id.toString(),
      senderId: r.senderId,
      senderName: r.senderName,
      recipientId: r.recipientId,
      recipientName: recipientNameMap[r.recipientId] || null,
      recipientEmail: r.recipientEmail,
      recipientPhone: r.recipientPhone,
      status: r.status,
      createdAt: r.createdAt,
      respondedAt: r.respondedAt,
      commonFriends: commonFriendsMap[r._id.toString()] ?? undefined,
    })));
  } catch (e) {

    logger.error("[friendRequests]", e.message);

    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// PUT /friends/requests/:requestId
router.put("/requests/:requestId", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const { requestId } = req.params;
    const { action } = req.body;
    const userId = String(req.user._id);

    if (!["accept", "decline"].includes(action)) {
      return res.status(400).json({ error: "Action invalide" });
    }

    const request = await db.collection("friendRequests").findOne({ _id: new ObjectId(requestId) });
    if (!request) return res.status(404).json({ error: "Demande introuvable" });
    if (request.status !== "pending") return res.status(400).json({ error: "Demande déjà traitée" });

    if (request.recipientId !== userId) {
      return res.status(403).json({ error: "Accès refusé" });
    }

    if (action === "decline") {
      await db.collection("friendRequests").deleteOne({ _id: new ObjectId(requestId) });
    } else {
      await db.collection("friendRequests").updateOne(
        { _id: new ObjectId(requestId) },
        { $set: { status: "accepted", respondedAt: new Date() } }
      );

      const now = new Date();
      const sender = await db.collection("users").findOne({ _id: new ObjectId(request.senderId) });
      await db.collection("friends").insertMany([
        { userId: request.senderId, friendId: request.recipientId, name: req.user.name, email: req.user.email, phone: req.user.phone, createdAt: now },
        { userId: request.recipientId, friendId: request.senderId, name: sender?.name || request.senderName, email: sender?.email, phone: sender?.phone, createdAt: now },
      ]);
    }

    return res.json({ success: true });
  } catch (e) {

    logger.error("[friendRequests]", e.message);

    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// DELETE /friends/requests/:requestId
router.delete("/requests/:requestId", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const { requestId } = req.params;
    const userId = String(req.user._id);

    const request = await db.collection("friendRequests").findOne({
      _id: new ObjectId(requestId), senderId: userId, status: "pending",
    });
    if (!request) return res.status(404).json({ error: "Demande introuvable ou déjà traitée" });

    await db.collection("friendRequests").deleteOne({ _id: new ObjectId(requestId) });
    return res.json({ success: true });
  } catch (e) {

    logger.error("[friendRequests]", e.message);

    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

module.exports = router;
