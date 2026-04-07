const express = require("express");
const crypto = require("crypto");
const { ObjectId } = require("mongodb");
const { getDb } = require("../db");
const { requireAuth } = require("../middleware/auth");
const {
  sendFriendRequestEmail,
  sendFriendRequestFoundEmail,
  sendFriendJoinedEmail,
} = require("../utils/email");

const router = express.Router();

// Utilitaire : lier les demandes d'amis en attente à un utilisateur nouvellement inscrit
async function linkPendingFriendRequests(userId, userEmail, userPhone) {
  try {
    const db = getDb();
    const conditions = [];
    if (userEmail) conditions.push({ recipientEmail: userEmail });
    if (userPhone) conditions.push({ recipientPhone: userPhone });
    if (conditions.length === 0) return 0;

    const pending = await db.collection("friendRequests").find({
      recipientId: null,
      status: "pending",
      $or: conditions,
    }).toArray();

    if (pending.length === 0) return 0;

    await db.collection("friendRequests").updateMany(
      { _id: { $in: pending.map((r) => r._id) } },
      { $set: { recipientId: userId } }
    );

    const newUser = await db.collection("users").findOne({ _id: new ObjectId(userId) });
    for (const request of pending) {
      const sender = await db.collection("users").findOne({ _id: new ObjectId(request.senderId) });
      if (sender) {
        await sendFriendRequestFoundEmail(
          sender.email,
          newUser?.name || userEmail,
          sender.language || "fr"
        );
      }
    }

    return pending.length;
  } catch (e) {
    console.error("[friends] Erreur lors du lien des demandes en attente :", e.message);
    return 0;
  }
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

    // Anti-auto-ajout
    if (
      recipientIdParam === senderId ||
      (recipientEmail && sender?.email && recipientEmail.toLowerCase() === sender.email.toLowerCase()) ||
      (recipientPhone && sender?.phone && recipientPhone === sender.phone)
    ) {
      return res.status(400).json({ error: "Impossible de s'envoyer une demande à soi-même" });
    }

    let recipientUser = null;
    if (recipientIdParam) {
      recipientUser = await db.collection("users").findOne({ _id: new ObjectId(recipientIdParam) });
    }
    if (!recipientUser && recipientEmail) {
      recipientUser = await db.collection("users").findOne({ email: recipientEmail });
    }
    if (!recipientUser && recipientPhone) {
      recipientUser = await db.collection("users").findOne({ phone: recipientPhone });
    }

    if (recipientUser && String(recipientUser._id) === senderId) {
      return res.status(400).json({ error: "Impossible de s'envoyer une demande à soi-même" });
    }

    if (recipientUser) {
      const recipientId = String(recipientUser._id);

      const existingFriendship = await db.collection("friends").findOne({
        $or: [{ userId: senderId, friendId: recipientId }, { userId: recipientId, friendId: senderId }],
      });
      if (existingFriendship) return res.status(400).json({ error: "Déjà amis" });

      // Auto-acceptation si demande inverse en attente
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
        return res.json({ success: true, autoAccepted: true });
      }

      const existingRequest = await db.collection("friendRequests").findOne({
        senderId, recipientId, status: "pending",
      });
      if (existingRequest) return res.status(400).json({ error: "Demande déjà en attente" });
    } else {
      const existingRequestQuery = { senderId, recipientId: null, status: "pending" };
      if (recipientEmail) existingRequestQuery.recipientEmail = recipientEmail;
      if (recipientPhone) existingRequestQuery.recipientPhone = recipientPhone;

      const existingRequest = await db.collection("friendRequests").findOne(existingRequestQuery);
      if (existingRequest) return res.status(400).json({ error: "Demande déjà en attente" });
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
      await sendFriendRequestEmail(
        recipientUser.email,
        sender?.name || "Quelqu'un",
        recipientUser.language || "fr"
      );
    }

    return res.json(friendRequest);
  } catch (e) {
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

    // Seul le destinataire peut accepter ou refuser
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
    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// GET /friends/suggestions
router.get("/suggestions", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const userId = String(req.user._id);

    const myFriends = await db.collection("friends").find({ userId }).toArray();
    const myFriendIds = myFriends.map((f) => f.friendId);
    if (myFriendIds.length === 0) return res.json([]);

    const friendsOfFriends = await db.collection("friends").find({
      userId: { $in: myFriendIds }, friendId: { $ne: userId },
    }).toArray();

    const commonCount = {};
    for (const fof of friendsOfFriends) {
      if (fof.friendId === userId || myFriendIds.includes(fof.friendId)) continue;
      commonCount[fof.friendId] = (commonCount[fof.friendId] || 0) + 1;
    }

    const suggestionIds = Object.keys(commonCount);
    if (suggestionIds.length === 0) return res.json([]);

    const pendingRequests = await db.collection("friendRequests").find({
      $or: [
        { senderId: userId, recipientId: { $in: suggestionIds }, status: "pending" },
        { senderId: { $in: suggestionIds }, recipientId: userId, status: "pending" },
      ],
    }).toArray();
    const pendingIds = new Set([
      ...pendingRequests.map((r) => r.recipientId),
      ...pendingRequests.map((r) => r.senderId),
    ]);

    const validIds = suggestionIds.filter((id) => !pendingIds.has(id));
    if (validIds.length === 0) return res.json([]);

    const users = await db.collection("users").find({
      _id: { $in: validIds.map((id) => { try { return new ObjectId(id); } catch { return null; } }).filter(Boolean) },
    }).project({ _id: 1, name: 1, email: 1, avatar: 1 }).limit(10).toArray();

    const suggestions = users.map((u) => ({
      id: String(u._id),
      name: u.name || "Utilisateur",
      email: u.email,
      avatar: u.avatar || null,
      commonFriends: commonCount[String(u._id)] || 0,
    }));

    suggestions.sort((a, b) => b.commonFriends - a.commonFriends);
    return res.json(suggestions);
  } catch (e) {
    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// GET /friends
router.get("/", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const userId = String(req.user._id);

    const limit = Math.min(parseInt(req.query.limit) || 100, 200);
    const skip = Math.max(parseInt(req.query.skip) || 0, 0);
    const friends = await db.collection("friends").find({ userId }).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray();

    const friendObjectIds = friends
      .map((f) => { try { return new ObjectId(f.friendId); } catch { return null; } })
      .filter(Boolean);

    const usersData = friendObjectIds.length > 0
      ? await db.collection("users").find({ _id: { $in: friendObjectIds } }, { projection: { _id: 1, avatar: 1 } }).toArray()
      : [];
    const avatarMap = new Map(usersData.map((u) => [String(u._id), u.avatar || null]));

    return res.json(friends.map((f) => ({
      id: f._id.toString(),
      userId: f.userId,
      friendId: f.friendId,
      name: f.name,
      email: f.email,
      phone: f.phone,
      avatar: avatarMap.get(f.friendId) ?? f.avatar ?? null,
      createdAt: f.createdAt,
    })));
  } catch (e) {
    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// DELETE /friends/:friendId
router.delete("/:friendId", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const { friendId } = req.params;
    const userId = String(req.user._id);

    await db.collection("friends").deleteMany({
      $or: [{ userId, friendId }, { userId: friendId, friendId: userId }],
    });

    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// GET /friends/:friendId/profile
router.get("/:friendId/profile", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const userId = String(req.user._id);
    const { friendId } = req.params;

    const friendUser = await db.collection("users").findOne({ _id: new ObjectId(friendId) });
    if (!friendUser) return res.status(404).json({ error: "Utilisateur introuvable" });

    const friendship = await db.collection("friends").findOne({ userId, friendId });
    const isFriend = !!friendship;

    if (!friendUser.isPublicProfile) {
      return res.json({
        id: String(friendUser._id),
        name: friendUser.name,
        avatar: friendUser.avatar || null,
        isFriend,
        friendSince: friendship?.createdAt || null,
        isPublicProfile: false,
        stats: null,
        commonTrips: [],
        sharedTrips: [],
      });
    }

    const friendTrips = await db.collection("trips").find({
      $or: [{ ownerId: friendId }, { "collaborators.userId": friendId }],
    }).toArray();

    const countries = new Set(friendTrips.map((t) => t.destination).filter(Boolean));

    let commonTrips = [];
    if (isFriend) {
      const myTrips = await db.collection("trips").find({
        $or: [{ ownerId: userId }, { "collaborators.userId": userId }],
      }).project({ _id: 1 }).toArray();
      const myTripIds = new Set(myTrips.map((t) => String(t._id)));
      commonTrips = friendTrips.filter((t) => myTripIds.has(String(t._id)));
    }

    const [myFriends, friendFriends] = await Promise.all([
      db.collection("friends").find({ userId }).project({ friendId: 1 }).toArray(),
      db.collection("friends").find({ userId: friendId }).project({ friendId: 1 }).toArray(),
    ]);
    const myFriendIds = new Set(myFriends.map((f) => f.friendId));
    const commonFriendsCount = friendFriends.filter((f) => myFriendIds.has(f.friendId)).length;
    const totalBookings = await db.collection("bookings").countDocuments({ userId: friendId });

    const visibilityFilter = isFriend ? { $in: ["friends", "public"] } : "public";
    const sharedTrips = await db.collection("trips").find({
      ownerId: friendId, visibility: visibilityFilter,
    }).sort({ createdAt: -1 }).toArray();

    const formatTrip = (t) => ({
      id: String(t._id),
      title: t.title,
      destination: t.destination,
      startDate: t.startDate,
      endDate: t.endDate,
      coverImage: t.coverImage || null,
      status: t.status,
      visibility: t.visibility || (t.isPublic ? "public" : "private"),
    });

    return res.json({
      id: String(friendUser._id),
      name: friendUser.name,
      email: friendUser.email,
      avatar: friendUser.avatar || null,
      isFriend,
      friendSince: friendship?.createdAt || null,
      isPublicProfile: true,
      stats: { commonTrips: commonTrips.length, totalTrips: friendTrips.length, countries: countries.size, commonFriends: commonFriendsCount, totalBookings },
      commonTrips: commonTrips.map(formatTrip),
      sharedTrips: sharedTrips.map(formatTrip),
    });
  } catch (e) {
    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

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
module.exports.linkPendingFriendRequests = linkPendingFriendRequests;
