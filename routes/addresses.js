const express = require("express");
const { ObjectId } = require("mongodb");
const { getDb } = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

const trim = (v) => (typeof v === "string" ? v.trim() : v);

// GET /addresses
router.get("/", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const userId = String(req.user._id);

    const userTrips = await db.collection("trips").find({
      $or: [{ ownerId: userId }, { "collaborators.userId": userId }],
    }).project({ _id: 1 }).toArray();
    const tripIds = userTrips.map((t) => String(t._id));

    const items = await db.collection("addresses").find({
      $or: [{ tripId: { $in: tripIds } }, { userId }],
    }).toArray();

    return res.json(items);
  } catch (e) {
    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// GET /addresses/trip/:tripId
router.get("/trip/:tripId", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const userId = String(req.user._id);
    const { tripId } = req.params;

    const trip = await db.collection("trips").findOne({ _id: new ObjectId(tripId) });
    if (!trip) return res.status(404).json({ error: "Voyage introuvable" });

    const isOwner = trip.ownerId === userId;
    const isCollaborator = trip.collaborators?.some((c) => c.userId === userId);
    const isPublic = trip.isPublic || trip.visibility === "public";

    if (!isOwner && !isCollaborator && !isPublic) {
      if (trip.visibility === "friends") {
        const friendship = await db.collection("friends").findOne({ userId, friendId: trip.ownerId });
        if (!friendship) return res.status(403).json({ error: "Accès refusé" });
      } else {
        return res.status(403).json({ error: "Accès refusé" });
      }
    }

    const items = await db.collection("addresses").find({ tripId }).toArray();
    return res.json(items);
  } catch (e) {
    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// GET /addresses/:id
router.get("/:id", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const userId = String(req.user._id);
    const item = await db.collection("addresses").findOne({ _id: new ObjectId(req.params.id) });
    if (!item) return res.status(404).json({ error: "Adresse introuvable" });

    const isOwner = item.userId === userId;
    if (!isOwner && item.tripId) {
      const trip = await db.collection("trips").findOne({ _id: new ObjectId(item.tripId) });
      const hasTripAccess = trip && (trip.ownerId === userId || trip.collaborators?.some((c) => c.userId === userId));
      if (!hasTripAccess) return res.status(403).json({ error: "Accès refusé" });
    } else if (!isOwner) {
      return res.status(403).json({ error: "Accès refusé" });
    }

    return res.json(item);
  } catch (e) {
    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// POST /addresses
router.post("/", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const userId = String(req.user._id);
    const { type, name, address, city, country, phone, website, notes, rating, tripId, photoUrl } = req.body;

    if (!type || !name || !address || !city || !country) {
      return res.status(400).json({ error: "Champs requis manquants" });
    }

    const doc = {
      type,
      name: trim(name),
      address: trim(address),
      city: trim(city),
      country: trim(country),
      phone: phone ? trim(phone) : undefined,
      website: website ? trim(website) : undefined,
      notes: notes ? trim(notes) : undefined,
      rating: typeof rating === "number" ? rating : undefined,
      photoUrl: photoUrl ? trim(photoUrl) : undefined,
      tripId: tripId || undefined,
      userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await db.collection("addresses").insertOne(doc);
    doc._id = result.insertedId;
    return res.status(201).json(doc);
  } catch (e) {
    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// PUT /addresses/:id
router.put("/:id", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const userId = String(req.user._id);
    const { id } = req.params;

    const existing = await db.collection("addresses").findOne({ _id: new ObjectId(id) });
    if (!existing) return res.status(404).json({ error: "Adresse introuvable" });

    const isOwner = existing.userId === userId;
    if (!isOwner && existing.tripId) {
      const trip = await db.collection("trips").findOne({ _id: new ObjectId(existing.tripId) });
      const canEdit = trip && (trip.ownerId === userId || trip.collaborators?.some((c) => c.userId === userId && c.permissions.canEdit));
      if (!canEdit) return res.status(403).json({ error: "Accès refusé" });
    } else if (!isOwner) {
      return res.status(403).json({ error: "Accès refusé" });
    }

    const { type, name, address, city, country, phone, website, notes, rating, photoUrl } = req.body;
    const setData = { updatedAt: new Date() };
    const unsetData = {};

    if (type !== undefined) setData.type = type;
    if (name !== undefined) setData.name = trim(name);
    if (address !== undefined) setData.address = trim(address);
    if (city !== undefined) setData.city = trim(city);
    if (country !== undefined) setData.country = trim(country);

    for (const [key, val] of [["phone", phone], ["website", website], ["notes", notes], ["photoUrl", photoUrl]]) {
      if (val !== undefined) {
        if (val) setData[key] = trim(val);
        else unsetData[key] = "";
      }
    }

    if (rating !== undefined) {
      if (typeof rating === "number") setData.rating = rating;
      else unsetData.rating = "";
    }

    const updatePayload = {};
    if (Object.keys(setData).length > 0) updatePayload.$set = setData;
    if (Object.keys(unsetData).length > 0) updatePayload.$unset = unsetData;

    await db.collection("addresses").updateOne({ _id: new ObjectId(id) }, updatePayload);
    const updated = await db.collection("addresses").findOne({ _id: new ObjectId(id) });
    return res.json(updated);
  } catch (e) {
    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// DELETE /addresses/:id
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const userId = String(req.user._id);
    const { id } = req.params;

    const address = await db.collection("addresses").findOne({ _id: new ObjectId(id) });
    if (!address) return res.status(404).json({ error: "Adresse introuvable" });

    const isCreator = address.userId === userId;
    if (!isCreator && address.tripId) {
      const trip = await db.collection("trips").findOne({ _id: new ObjectId(address.tripId) });
      const canDelete = trip && (trip.ownerId === userId || trip.collaborators?.some((c) => c.userId === userId && c.permissions.canDelete));
      if (!canDelete) return res.status(403).json({ error: "Accès refusé" });
    } else if (!isCreator) {
      return res.status(403).json({ error: "Accès refusé" });
    }

    await db.collection("addresses").deleteOne({ _id: new ObjectId(id) });
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

module.exports = router;
