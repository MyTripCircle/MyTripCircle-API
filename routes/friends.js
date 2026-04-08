const express = require("express");
const { ObjectId } = require("mongodb");
const { getDb } = require("../db");
const { requireAuth } = require("../middleware/auth");
const logger = require("../utils/logger");
const { sendFriendRequestFoundEmail } = require("../utils/email");

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
    logger.error("[friends] Erreur lors du lien des demandes en attente :", e.message);
    return 0;
  }
}

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

module.exports = router;
module.exports.linkPendingFriendRequests = linkPendingFriendRequests;
