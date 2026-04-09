const { ObjectId } = require("mongodb");
const { getDb } = require("../db");

async function checkTripReadAccess(db, tripId, userId) {
  const trip = await db.collection("trips").findOne({ _id: new ObjectId(tripId) });
  if (!trip) return false;
  const isOwner        = trip.ownerId === userId;
  const isCollaborator = trip.collaborators?.some((c) => c.userId === userId);
  const isPublic       = trip.isPublic || trip.visibility === "public";
  if (isOwner || isCollaborator || isPublic) return true;
  if (trip.visibility === "friends") {
    const friendship = await db.collection("friends").findOne({ userId, friendId: trip.ownerId });
    return !!friendship;
  }
  return false;
}

async function getBookingsForUser(userId) {
  const db = getDb();
  const userTrips = await db.collection("trips").find({
    $or: [{ ownerId: userId }, { "collaborators.userId": userId }],
  }).project({ _id: 1 }).toArray();
  const tripIds = userTrips.map((t) => String(t._id));

  return db.collection("bookings").find({
    $or: [
      { tripId: { $in: tripIds } },
      { userId, tripId: { $in: ["", null] } },
      { userId, tripId: { $exists: false } },
    ],
  }).toArray();
}

async function getBookingsByTripId(tripId, userId) {
  const db = getDb();
  const hasAccess = await checkTripReadAccess(db, tripId, userId);
  if (!hasAccess) return { error: "Accès refusé", status: 403 };
  const items = await db.collection("bookings").find({ tripId }).toArray();
  return { items };
}

async function getBookingById(id, userId) {
  const db = getDb();
  const booking = await db.collection("bookings").findOne({ _id: new ObjectId(id) });
  if (!booking) return { error: "Réservation introuvable", status: 404 };

  if (booking.tripId) {
    const hasAccess = await checkTripReadAccess(db, booking.tripId, userId);
    if (!hasAccess && booking.userId !== userId) return { error: "Accès refusé", status: 403 };
  } else if (booking.userId !== userId) {
    return { error: "Accès refusé", status: 403 };
  }
  return { booking };
}

async function createBooking(data, userId) {
  const db = getDb();
  const { tripId, type, title, description, date, endDate, time, address, confirmationNumber, price, currency, status, attachments } = data;

  if (!type || !title || !date) {
    return { error: "Champs requis manquants (type, title, date)", status: 400 };
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
    price: price ? Number.parseFloat(price) : undefined,
    currency: currency || "EUR",
    status: status || "pending",
    attachments: attachments || [],
    userId,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const result = await db.collection("bookings").insertOne(booking);
  booking._id = result.insertedId;
  return { booking };
}

async function checkBookingWriteAccess(db, id, userId, permissionKey = "canEdit") {
  const booking = await db.collection("bookings").findOne({ _id: new ObjectId(id) });
  if (!booking) return { booking: null, hasAccess: false };

  if (booking.userId === userId) return { booking, hasAccess: true };

  if (booking.tripId) {
    const trip = await db.collection("trips").findOne({ _id: new ObjectId(booking.tripId) });
    if (trip) {
      const hasAccess =
        trip.ownerId === userId ||
        trip.collaborators?.some((c) => c.userId === userId && c.permissions[permissionKey]);
      return { booking, hasAccess };
    }
  }
  return { booking, hasAccess: false };
}

async function updateBooking(id, data, userId) {
  const db = getDb();
  const { booking, hasAccess } = await checkBookingWriteAccess(db, id, userId, "canEdit");
  if (!booking)   return { error: "Réservation introuvable", status: 404 };
  if (!hasAccess) return { error: "Accès refusé", status: 403 };

  const allowed = ["type", "title", "description", "date", "endDate", "time", "address", "confirmationNumber", "price", "currency", "status", "attachments"];
  const updates = { updatedAt: new Date() };
  for (const key of allowed) {
    if (data[key] !== undefined) updates[key] = data[key];
  }

  await db.collection("bookings").updateOne({ _id: new ObjectId(id) }, { $set: updates });
  const updated = await db.collection("bookings").findOne({ _id: new ObjectId(id) });
  return { booking: updated };
}

async function deleteBooking(id, userId) {
  const db = getDb();
  const { booking, hasAccess } = await checkBookingWriteAccess(db, id, userId, "canDelete");
  if (!booking)   return { error: "Réservation introuvable", status: 404 };
  if (!hasAccess) return { error: "Accès refusé", status: 403 };

  await db.collection("bookings").deleteOne({ _id: new ObjectId(id) });
  return { success: true };
}

module.exports = {
  getBookingsForUser,
  getBookingsByTripId,
  getBookingById,
  createBooking,
  updateBooking,
  deleteBooking,
};
