const express = require("express");
const { ObjectId } = require("mongodb");
const { getDb } = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

async function checkTripAccess(db, tripId, userId) {
  if (!tripId) return false;
  const trip = await db.collection("trips").findOne({ _id: new ObjectId(tripId) });
  if (!trip) return false;

  const isOwner = trip.ownerId === userId;
  const isCollaborator = trip.collaborators?.some((c) => c.userId === userId);
  const isPublic = trip.isPublic || trip.visibility === "public";

  if (isOwner || isCollaborator || isPublic) return true;

  if (trip.visibility === "friends") {
    const friendship = await db.collection("friends").findOne({ userId, friendId: trip.ownerId });
    return !!friendship;
  }

  return false;
}

// POST /bookings
router.post("/", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const userId = String(req.user._id);
    const { tripId, type, title, description, date, endDate, time, address, confirmationNumber, price, currency, status, attachments } = req.body;

    if (!type || !title || !date) {
      return res.status(400).json({ error: "Champs requis manquants (type, title, date)" });
    }

    const booking = {
      tripId: tripId || "",
      type,
      title: title.trim(),
      description: description ? description.trim() : undefined,
      date: new Date(date),
      endDate: endDate ? new Date(endDate) : undefined,
      time: time || undefined,
      address: address ? address.trim() : undefined,
      confirmationNumber: confirmationNumber ? confirmationNumber.trim() : undefined,
      price: price ? parseFloat(price) : undefined,
      currency: currency || "EUR",
      status: status || "pending",
      attachments: attachments || [],
      userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await db.collection("bookings").insertOne(booking);
    booking._id = result.insertedId;

    return res.status(201).json(booking);
  } catch (e) {
    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// GET /bookings
router.get("/", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const userId = String(req.user._id);

    const userTrips = await db.collection("trips").find({
      $or: [{ ownerId: userId }, { "collaborators.userId": userId }],
    }).project({ _id: 1 }).toArray();
    const tripIds = userTrips.map((t) => String(t._id));

    const items = await db.collection("bookings").find({
      $or: [
        { tripId: { $in: tripIds } },
        { userId, tripId: { $in: ["", null] } },
        { userId, tripId: { $exists: false } },
      ],
    }).toArray();

    return res.json(items);
  } catch (e) {
    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// GET /bookings/trip/:tripId
router.get("/trip/:tripId", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const userId = String(req.user._id);
    const { tripId } = req.params;

    const hasAccess = await checkTripAccess(db, tripId, userId);
    if (!hasAccess) return res.status(403).json({ error: "Accès refusé" });

    const items = await db.collection("bookings").find({ tripId }).toArray();
    return res.json(items);
  } catch (e) {
    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// GET /bookings/:id
router.get("/:id", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const userId = String(req.user._id);
    const booking = await db.collection("bookings").findOne({ _id: new ObjectId(req.params.id) });
    if (!booking) return res.status(404).json({ error: "Réservation introuvable" });

    if (booking.tripId) {
      const hasAccess = await checkTripAccess(db, booking.tripId, userId);
      if (!hasAccess && booking.userId !== userId) return res.status(403).json({ error: "Accès refusé" });
    } else if (booking.userId !== userId) {
      return res.status(403).json({ error: "Accès refusé" });
    }

    return res.json(booking);
  } catch (e) {
    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// PUT /bookings/:id
router.put("/:id", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const userId = String(req.user._id);
    const { id } = req.params;

    const booking = await db.collection("bookings").findOne({ _id: new ObjectId(id) });
    if (!booking) return res.status(404).json({ error: "Réservation introuvable" });

    const isCreator = booking.userId === userId;
    let hasTripAccess = false;

    if (booking.tripId && !isCreator) {
      const trip = await db.collection("trips").findOne({ _id: new ObjectId(booking.tripId) });
      if (trip) {
        hasTripAccess =
          trip.ownerId === userId ||
          trip.collaborators?.some((c) => c.userId === userId && c.permissions.canEdit);
      }
    }

    if (!isCreator && !hasTripAccess) return res.status(403).json({ error: "Accès refusé" });

    const allowed = ["type", "title", "description", "date", "endDate", "time", "address", "confirmationNumber", "price", "currency", "status", "attachments"];
    const updates = { updatedAt: new Date() };
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    await db.collection("bookings").updateOne({ _id: new ObjectId(id) }, { $set: updates });
    const updated = await db.collection("bookings").findOne({ _id: new ObjectId(id) });
    return res.json(updated);
  } catch (e) {
    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// DELETE /bookings/:id
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const userId = String(req.user._id);
    const { id } = req.params;

    const booking = await db.collection("bookings").findOne({ _id: new ObjectId(id) });
    if (!booking) return res.status(404).json({ error: "Réservation introuvable" });

    const isCreator = booking.userId === userId;
    let hasTripAccess = false;

    if (booking.tripId && !isCreator) {
      const trip = await db.collection("trips").findOne({ _id: new ObjectId(booking.tripId) });
      if (trip) {
        hasTripAccess =
          trip.ownerId === userId ||
          trip.collaborators?.some((c) => c.userId === userId && c.permissions.canDelete);
      }
    }

    if (!isCreator && !hasTripAccess) return res.status(403).json({ error: "Accès refusé" });

    await db.collection("bookings").deleteOne({ _id: new ObjectId(id) });
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

module.exports = router;
