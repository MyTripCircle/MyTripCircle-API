const express = require("express");
const logger = require("../utils/logger");
const { ObjectId } = require("mongodb");
const { getDb } = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// GET /trips
router.get("/", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const userId = String(req.user._id);
    const items = await db.collection("trips").find({
      $or: [{ ownerId: userId }, { "collaborators.userId": userId }],
    }).toArray();
    return res.json(items);
  } catch (e) {

    logger.error("[trips]", e.message);

    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// GET /trips/:id
router.get("/:id", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const userId = String(req.user._id);
    const item = await db.collection("trips").findOne({ _id: new ObjectId(req.params.id) });
    if (!item) return res.status(404).json({ error: "Voyage introuvable" });

    const isOwner = item.ownerId === userId;
    const isCollaborator = item.collaborators?.some((c) => c.userId === userId);
    const isPublicTrip = item.isPublic || item.visibility === "public";

    if (!isOwner && !isCollaborator && !isPublicTrip) {
      if (item.visibility === "friends") {
        const friendship = await db.collection("friends").findOne({ userId, friendId: item.ownerId });
        if (!friendship) return res.status(403).json({ error: "Accès refusé" });
      } else {
        return res.status(403).json({ error: "Accès refusé" });
      }
    }

    return res.json(item);
  } catch (e) {

    logger.error("[trips]", e.message);

    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// POST /trips
router.post("/", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const userId = String(req.user._id);
    const { title, description, destination, startDate, endDate, isPublic, visibility, tags, status } = req.body;

    if (!title || !destination || !startDate || !endDate) {
      return res.status(400).json({ error: "Champs requis manquants" });
    }

    const start = new Date(startDate);
    const end = new Date(endDate);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (start >= end) {
      return res.status(400).json({ error: "La date de fin doit être après la date de début" });
    }

    const startDay = new Date(start);
    startDay.setHours(0, 0, 0, 0);
    if (startDay < today) {
      return res.status(400).json({ error: "La date de début ne peut pas être dans le passé" });
    }

    const trip = {
      title: title.trim(),
      description: description ? description.trim() : "",
      destination: destination.trim(),
      startDate: start,
      endDate: end,
      ownerId: userId,
      collaborators: [],
      isPublic: isPublic || false,
      visibility: visibility || (isPublic ? "public" : "private"),
      status: status || "draft",
      tags: tags || [],
      stats: { totalBookings: 0, totalAddresses: 0, totalCollaborators: 0 },
      location: { type: "Point", coordinates: [0, 0] },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await db.collection("trips").insertOne(trip);
    trip._id = result.insertedId;

    return res.status(201).json(trip);
  } catch (e) {

    logger.error("[trips]", e.message);

    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// PUT /trips/:id
router.put("/:id", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const userId = String(req.user._id);
    const { id } = req.params;

    const existing = await db.collection("trips").findOne({ _id: new ObjectId(id) });
    if (!existing) return res.status(404).json({ error: "Voyage introuvable" });

    const isOwner = existing.ownerId === userId;
    const isCollaborator = existing.collaborators.some(
      (c) => c.userId === userId && c.permissions.canEdit
    );
    if (!isOwner && !isCollaborator) {
      return res.status(403).json({ error: "Non autorisé à modifier ce voyage" });
    }

    const { title, description, destination, startDate, endDate, isPublic, status, visibility } = req.body;

    if (startDate && endDate && new Date(startDate) >= new Date(endDate)) {
      return res.status(400).json({ error: "La date de fin doit être après la date de début" });
    }

    const updateData = { updatedAt: new Date() };
    if (title !== undefined) updateData.title = title.trim();
    if (description !== undefined) updateData.description = description.trim();
    if (destination !== undefined) updateData.destination = destination.trim();
    if (startDate !== undefined) updateData.startDate = new Date(startDate);
    if (endDate !== undefined) updateData.endDate = new Date(endDate);
    if (isPublic !== undefined) updateData.isPublic = isPublic;
    if (status !== undefined) updateData.status = status;
    if (visibility !== undefined) updateData.visibility = visibility;

    await db.collection("trips").updateOne({ _id: new ObjectId(id) }, { $set: updateData });
    const updated = await db.collection("trips").findOne({ _id: new ObjectId(id) });
    return res.json(updated);
  } catch (e) {

    logger.error("[trips]", e.message);

    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// DELETE /trips/:id
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const userId = String(req.user._id);
    const { id } = req.params;

    const existing = await db.collection("trips").findOne({ _id: new ObjectId(id) });
    if (!existing) return res.status(404).json({ error: "Voyage introuvable" });
    if (existing.ownerId !== userId) {
      return res.status(403).json({ error: "Seul le propriétaire peut supprimer ce voyage" });
    }

    await Promise.all([
      db.collection("trips").deleteOne({ _id: new ObjectId(id) }),
      db.collection("bookings").deleteMany({ tripId: id }),
      db.collection("addresses").deleteMany({ tripId: id }),
      db.collection("invitations").deleteMany({ tripId: id }),
    ]);

    return res.json({ success: true });
  } catch (e) {

    logger.error("[trips]", e.message);

    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// DELETE /trips/:id/collaborators/:userId
router.delete("/:id/collaborators/:userId", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const requesterId = String(req.user._id);
    const { id, userId } = req.params;

    const trip = await db.collection("trips").findOne({ _id: new ObjectId(id) });
    if (!trip) return res.status(404).json({ error: "Voyage introuvable" });
    if (trip.ownerId !== requesterId) {
      return res.status(403).json({ error: "Seul le propriétaire peut retirer des membres" });
    }
    if (userId === requesterId) {
      return res.status(400).json({ error: "Impossible de se retirer soi-même" });
    }

    await db.collection("trips").updateOne(
      { _id: new ObjectId(id) },
      { $pull: { collaborators: { userId } } }
    );
    return res.json({ success: true });
  } catch (e) {

    logger.error("[trips]", e.message);

    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// PUT /trips/:id/transfer-ownership
router.put("/:id/transfer-ownership", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const requesterId = String(req.user._id);
    const { id } = req.params;
    const { newOwnerId } = req.body;

    if (!newOwnerId) return res.status(400).json({ error: "newOwnerId requis" });

    const trip = await db.collection("trips").findOne({ _id: new ObjectId(id) });
    if (!trip) return res.status(404).json({ error: "Voyage introuvable" });
    if (trip.ownerId !== requesterId) {
      return res.status(403).json({ error: "Seul le propriétaire peut transférer la propriété" });
    }

    const isCollaborator = trip.collaborators?.some((c) => c.userId === newOwnerId);
    if (!isCollaborator) {
      return res.status(400).json({ error: "Le nouveau propriétaire doit déjà être membre" });
    }

    await db.collection("trips").updateOne(
      { _id: new ObjectId(id) },
      { $set: { ownerId: newOwnerId }, $pull: { collaborators: { userId: newOwnerId } } }
    );
    await db.collection("trips").updateOne(
      { _id: new ObjectId(id) },
      {
        $push: {
          collaborators: {
            userId: requesterId,
            role: "editor",
            joinedAt: new Date(),
            permissions: { canEdit: true, canInvite: true, canDelete: false },
          },
        },
      }
    );

    return res.json({ success: true });
  } catch (e) {

    logger.error("[trips]", e.message);

    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

module.exports = router;
