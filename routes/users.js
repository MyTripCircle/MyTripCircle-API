const express = require("express");
const bcrypt = require("bcrypt");
const logger = require("../utils/logger");
const { ObjectId } = require("mongodb");
const { getDb } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { sanitizeUser, isStrongPassword, trimIfString } = require("../utils/authHelpers");
const { linkPendingFriendRequests } = require("./friends");
const { isValidEmail, isValidPhone } = require("../utils/validators");
const { hashField, encrypt, decrypt, decryptUserFields } = require("../utils/crypto");

const router = express.Router();

function determineRelation(alreadyFriend, pendingSent, pendingReceived) {
  if (alreadyFriend) return "friend";
  if (pendingSent) return "pending_sent";
  if (pendingReceived) return "pending_received";
  return "none";
}

// PUT /users/me
router.put("/me", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const userId = req.user._id;
    const name = trimIfString(req.body?.name);
    const email = trimIfString(req.body?.email)?.toLowerCase();
    const phone = trimIfString(req.body?.phone);

    if (!name || !email) {
      return res.status(400).json({ success: false, error: "Nom et email requis" });
    }

    const existing = await db.collection("users").findOne({ emailHash: hashField(email), _id: { $ne: userId } });
    if (existing) return res.status(409).json({ success: false, error: "Email déjà utilisé" });

    const updateData = {
      name,
      email: encrypt(email),
      emailHash: hashField(email),
      updatedAt: new Date(),
    };
    if (phone !== undefined) {
      updateData.phone = phone ? encrypt(phone) : null;
      updateData.phoneHash = phone ? hashField(phone) : null;
    }

    const language = req.body?.language;
    if (language === "en" || language === "fr") updateData.language = language;

    await db.collection("users").updateOne({ _id: userId }, { $set: updateData });

    await linkPendingFriendRequests(String(userId), email, phone || null);

    const updated = await db.collection("users").findOne({ _id: userId });
    return res.json({ success: true, user: sanitizeUser(updated) });
  } catch (e) {

    logger.error("[users]", e.message);

    return res.status(500).json({ success: false, error: "Erreur interne du serveur" });
  }
});

// PUT /users/avatar
router.put("/avatar", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const userId = req.user._id;
    const { avatar } = req.body;

    if (!avatar || typeof avatar !== "string") {
      return res.status(400).json({ success: false, error: "Avatar requis" });
    }

    const ALLOWED_IMAGE_MIMES = ["data:image/jpeg;", "data:image/png;", "data:image/webp;", "data:image/gif;"];
    if (avatar.startsWith("data:")) {
      const isSafeDataUrl = ALLOWED_IMAGE_MIMES.some((prefix) => avatar.startsWith(prefix));
      if (!isSafeDataUrl) {
        return res.status(400).json({ success: false, error: "Format d'avatar invalide (JPEG, PNG, WEBP ou GIF uniquement)" });
      }
      if (Buffer.byteLength(avatar) > 5 * 1024 * 1024) {
        return res.status(400).json({ success: false, error: "Avatar trop volumineux (5 Mo max)" });
      }
    } else {
      try {
        const url = new URL(avatar);
        if (url.protocol !== "https:") {
          return res.status(400).json({ success: false, error: "URL d'avatar invalide (HTTPS requis)" });
        }
      } catch {
        return res.status(400).json({ success: false, error: "Format d'avatar invalide" });
      }
    }

    await db.collection("users").updateOne({ _id: userId }, { $set: { avatar, updatedAt: new Date() } });
    await db.collection("friends").updateMany({ friendId: String(userId) }, { $set: { avatar } });

    const updated = await db.collection("users").findOne({ _id: userId });
    return res.json({ success: true, user: sanitizeUser(updated) });
  } catch (e) {

    logger.error("[users]", e.message);

    return res.status(500).json({ success: false, error: "Erreur interne du serveur" });
  }
});

// PUT /users/settings
router.put("/settings", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const { isPublicProfile } = req.body;

    if (typeof isPublicProfile !== "boolean") {
      return res.status(400).json({ success: false, error: "isPublicProfile doit être un booléen" });
    }

    await db.collection("users").updateOne(
      { _id: req.user._id },
      { $set: { isPublicProfile, updatedAt: new Date() } }
    );
    const updated = await db.collection("users").findOne({ _id: req.user._id });
    return res.json({ success: true, user: sanitizeUser(updated) });
  } catch (e) {

    logger.error("[users]", e.message);

    return res.status(500).json({ success: false, error: "Erreur interne du serveur" });
  }
});

// PUT /users/language
router.put("/language", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const { language } = req.body;

    if (language !== "en" && language !== "fr") {
      return res.status(400).json({ success: false, error: "Langue invalide. Valeurs acceptées : en, fr" });
    }

    await db.collection("users").updateOne(
      { _id: req.user._id },
      { $set: { language, updatedAt: new Date() } }
    );
    return res.json({ success: true, language });
  } catch (e) {

    logger.error("[users]", e.message);

    return res.status(500).json({ success: false, error: "Erreur interne du serveur" });
  }
});

// PUT /users/change-password
router.put("/change-password", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, error: "Champs requis manquants" });
    }

    const storedHash = req.user.passwordHash || req.user.password;
    if (!storedHash || !(await bcrypt.compare(currentPassword, storedHash))) {
      return res.status(400).json({ success: false, error: "Mot de passe actuel incorrect" });
    }

    if (!isStrongPassword(newPassword)) {
      return res.status(400).json({ success: false, error: "Mot de passe trop faible", field: "password" });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await db.collection("users").updateOne(
      { _id: req.user._id },
      { $set: { password: passwordHash, updatedAt: new Date() }, $unset: { passwordHash: "" } }
    );

    return res.json({ success: true });
  } catch (e) {

    logger.error("[users]", e.message);

    return res.status(500).json({ success: false, error: "Erreur interne du serveur" });
  }
});

// DELETE /users/me
router.delete("/me", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const userId = req.user._id;
    const userIdStr = String(userId);

    await Promise.all([
      db.collection("trips").deleteMany({ ownerId: userIdStr }),
      db.collection("bookings").deleteMany({ userId: userIdStr }),
      db.collection("addresses").deleteMany({ userId: userIdStr }),
      db.collection("invitations").deleteMany({
        $or: [{ inviterId: userIdStr }, { inviteeId: userIdStr }],
      }),
      db.collection("friends").deleteMany({
        $or: [{ userId: userIdStr }, { friendId: userIdStr }],
      }),
      db.collection("friendRequests").deleteMany({
        $or: [{ senderId: userIdStr }, { recipientId: userIdStr }],
      }),
      db.collection("refreshTokens").deleteMany({ userId: userIdStr }),
      db.collection("itinerary_usage").deleteMany({ userId: userIdStr }),
    ]);

    await db.collection("users").deleteOne({ _id: userId });
    return res.json({ success: true });
  } catch (e) {

    logger.error("[users]", e.message);

    return res.status(500).json({ success: false, error: "Erreur interne du serveur" });
  }
});

// POST /users/batch
router.post("/batch", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const { ids } = req.body;

    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100) {
      return res.status(400).json({ error: "Tableau d'IDs requis (1 à 100)" });
    }

    const objectIds = ids
      .map((id) => { try { return new ObjectId(id); } catch { return null; } })
      .filter(Boolean);

    const users = await db.collection("users").find({ _id: { $in: objectIds } }).toArray();
    return res.json(users.map((u) => ({
      _id: u._id,
      id: String(u._id),
      name: u.name,
      email: u.email ? decrypt(u.email) : null,
      avatar: u.avatar,
    })));
  } catch (e) {

    logger.error("[users]", e.message);

    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// GET /users/lookup
router.get("/lookup", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const userId = String(req.user._id);
    const { email, phone } = req.query;

    if (!email && !phone) return res.status(400).json({ error: "email ou phone requis" });

    if (email && !isValidEmail(email.trim())) {
      return res.status(400).json({ error: "Format d'email invalide" });
    }
    if (phone && !isValidPhone(phone.trim())) {
      return res.status(400).json({ error: "Format de téléphone invalide" });
    }

    const query = email
      ? { emailHash: hashField(email.toLowerCase().trim()) }
      : { phoneHash: hashField(phone.trim()) };

    const found = await db.collection("users").findOne(query);
    if (!found) return res.status(404).json({ error: "Utilisateur introuvable" });
    if (String(found._id) === userId) return res.status(400).json({ error: "Impossible de s'ajouter soi-même" });

    const foundId = String(found._id);

    const [totalTrips, trips, myFriends, theirFriends, alreadyFriend, pendingSent, pendingReceived] = await Promise.all([
      db.collection("trips").countDocuments({ $or: [{ ownerId: foundId }, { "collaborators.userId": foundId }] }),
      db.collection("trips").find({ $or: [{ ownerId: foundId }, { "collaborators.userId": foundId }] }).project({ destination: 1 }).toArray(),
      db.collection("friends").find({ userId }).toArray(),
      db.collection("friends").find({ userId: foundId }).toArray(),
      db.collection("friends").findOne({ userId, friendId: foundId }),
      db.collection("friendRequests").findOne({ senderId: userId, recipientId: foundId, status: "pending" }),
      db.collection("friendRequests").findOne({ senderId: foundId, recipientId: userId, status: "pending" }),
    ]);

    const countries = new Set(trips.map((t) => t.destination).filter(Boolean)).size;
    const myFriendIds = new Set(myFriends.map((f) => f.friendId));
    const commonFriends = theirFriends.filter((f) => myFriendIds.has(f.friendId)).length;

    const decryptedFound = decryptUserFields(found);
    return res.json({
      id: foundId,
      name: decryptedFound.name,
      email: decryptedFound.email,
      avatar: decryptedFound.avatar || null,
      stats: { totalTrips, countries, commonFriends },
      relation: determineRelation(alreadyFriend, pendingSent, pendingReceived),
    });
  } catch (e) {

    logger.error("[users]", e.message);

    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// GET /users/me/export — export RGPD de toutes les données personnelles
router.get("/me/export", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const userId = req.user._id;
    const userIdStr = String(userId);

    const [user, trips, bookings, addresses, friends] = await Promise.all([
      db.collection("users").findOne({ _id: userId }),
      db.collection("trips").find({ ownerId: userIdStr }).toArray(),
      db.collection("bookings").find({ userId: userIdStr }).toArray(),
      db.collection("addresses").find({ userId: userIdStr }).toArray(),
      db.collection("friends").find({ userId: userIdStr }).toArray(),
    ]);

    const exported = {
      exportedAt: new Date().toISOString(),
      profile: {
        id: userIdStr,
        name: user.name,
        email: user.email,
        phone: user.phone || null,
        language: user.language || "fr",
        createdAt: user.createdAt,
      },
      trips: trips.map((t) => ({
        id: String(t._id),
        destination: t.destination,
        startDate: t.startDate,
        endDate: t.endDate,
        description: t.description,
        collaborators: t.collaborators,
        createdAt: t.createdAt,
      })),
      bookings: bookings.map((b) => ({
        id: String(b._id),
        type: b.type,
        date: b.date,
        address: b.address,
        confirmationNumber: b.confirmationNumber,
        createdAt: b.createdAt,
      })),
      addresses: addresses.map((a) => ({
        id: String(a._id),
        label: a.label,
        formattedAddress: a.formattedAddress,
        coordinates: a.coordinates,
        createdAt: a.createdAt,
      })),
      friends: friends.map((f) => ({ friendId: f.friendId, createdAt: f.createdAt })),
    };

    res.setHeader("Content-Disposition", "attachment; filename=mytripcircle-export.json");
    res.setHeader("Content-Type", "application/json");
    return res.json(exported);
  } catch (e) {
    logger.error("[users]", e.message);
    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

module.exports = router;
