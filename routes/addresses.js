const express = require("express");
const logger = require("../utils/logger");
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

    logger.error("[addresses]", e.message);

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

    logger.error("[addresses]", e.message);

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

    logger.error("[addresses]", e.message);

    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// POST /addresses
router.post("/", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const userId = String(req.user._id);
    const { type, name, address, city, country, phone, website, notes, rating, tripId, photoUrl } = req.body;

    const VALID_TYPES = ["hotel", "restaurant", "activity", "transport", "other"];
    if (!type || !VALID_TYPES.includes(type)) {
      return res.status(400).json({ error: `Type invalide. Valeurs acceptées : ${VALID_TYPES.join(", ")}` });
    }
    if (!name || typeof name !== "string" || name.trim().length === 0 || name.trim().length > 200) {
      return res.status(400).json({ error: "Nom requis (1-200 caractères)" });
    }
    if (!address || typeof address !== "string" || address.trim().length === 0 || address.trim().length > 500) {
      return res.status(400).json({ error: "Adresse requise (1-500 caractères)" });
    }
    if (!city || typeof city !== "string" || city.trim().length === 0 || city.trim().length > 100) {
      return res.status(400).json({ error: "Ville requise (1-100 caractères)" });
    }
    if (!country || typeof country !== "string" || country.trim().length === 0 || country.trim().length > 100) {
      return res.status(400).json({ error: "Pays requis (1-100 caractères)" });
    }
    if (rating !== undefined && (typeof rating !== "number" || rating < 0 || rating > 5)) {
      return res.status(400).json({ error: "Note invalide (0-5)" });
    }
    if (website) {
      try { const u = new URL(website); if (!["http:", "https:"].includes(u.protocol)) throw new Error("Protocole non autorisé"); }
      catch { return res.status(400).json({ error: "URL du site invalide" }); }
    }
    if (photoUrl) {
      try { const u = new URL(photoUrl); if (!["http:", "https:"].includes(u.protocol)) throw new Error("Protocole non autorisé"); }
      catch { return res.status(400).json({ error: "URL de la photo invalide" }); }
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

    logger.error("[addresses]", e.message);

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

    const VALID_TYPES = ["hotel", "restaurant", "activity", "transport", "other"];
    if (type !== undefined && !VALID_TYPES.includes(type)) {
      return res.status(400).json({ error: `Type invalide. Valeurs acceptées : ${VALID_TYPES.join(", ")}` });
    }
    if (name !== undefined && (typeof name !== "string" || name.trim().length === 0 || name.trim().length > 200)) {
      return res.status(400).json({ error: "Nom invalide (1-200 caractères)" });
    }
    if (address !== undefined && (typeof address !== "string" || address.trim().length === 0 || address.trim().length > 500)) {
      return res.status(400).json({ error: "Adresse invalide (1-500 caractères)" });
    }
    if (city !== undefined && (typeof city !== "string" || city.trim().length === 0 || city.trim().length > 100)) {
      return res.status(400).json({ error: "Ville invalide (1-100 caractères)" });
    }
    if (country !== undefined && (typeof country !== "string" || country.trim().length === 0 || country.trim().length > 100)) {
      return res.status(400).json({ error: "Pays invalide (1-100 caractères)" });
    }
    if (rating !== undefined && rating !== null && (typeof rating !== "number" || rating < 0 || rating > 5)) {
      return res.status(400).json({ error: "Note invalide (0-5)" });
    }
    if (website) {
      try { const u = new URL(website); if (!["http:", "https:"].includes(u.protocol)) throw new Error("Protocole non autorisé"); }
      catch { return res.status(400).json({ error: "URL du site invalide" }); }
    }
    if (photoUrl) {
      try { const u = new URL(photoUrl); if (!["http:", "https:"].includes(u.protocol)) throw new Error("Protocole non autorisé"); }
      catch { return res.status(400).json({ error: "URL de la photo invalide" }); }
    }

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

    logger.error("[addresses]", e.message);

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

    logger.error("[addresses]", e.message);

    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

module.exports = router;
