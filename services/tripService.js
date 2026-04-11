const { ObjectId } = require("mongodb");
const { getDb } = require("../db");

async function checkTripReadAccess(db, tripId, userId) {
  const trip = await db.collection("trips").findOne({ _id: new ObjectId(tripId) });
  if (!trip) return { trip: null, hasAccess: false };

  const isOwner        = trip.ownerId === userId;
  const isCollaborator = trip.collaborators?.some((c) => c.userId === userId);
  const isPublic       = trip.isPublic || trip.visibility === "public";

  if (isOwner || isCollaborator || isPublic) return { trip, hasAccess: true };

  if (trip.visibility === "friends") {
    const friendship = await db.collection("friends").findOne({ userId, friendId: trip.ownerId });
    return { trip, hasAccess: !!friendship };
  }
  return { trip, hasAccess: false };
}

async function checkTripWriteAccess(db, tripId, userId) {
  const trip = await db.collection("trips").findOne({ _id: new ObjectId(tripId) });
  if (!trip) return { trip: null, hasAccess: false };

  const isOwner        = trip.ownerId === userId;
  const isCollaborator = trip.collaborators?.some((c) => c.userId === userId && c.permissions.canEdit);
  return { trip, hasAccess: isOwner || isCollaborator };
}

async function getTripsForUser(userId) {
  const db = getDb();
  return db.collection("trips").find({
    $or: [{ ownerId: userId }, { "collaborators.userId": userId }],
  }).toArray();
}

async function getTripById(tripId, userId) {
  const db = getDb();
  const { trip, hasAccess } = await checkTripReadAccess(db, tripId, userId);
  if (!trip) return { error: "Voyage introuvable", status: 404 };
  if (!hasAccess) return { error: "Accès refusé", status: 403 };
  return { trip };
}

async function createTrip(data, userId) {
  const db = getDb();
  const { title, description, destination, startDate, endDate, isPublic, visibility, tags, status, coverImage } = data;

  if (!title || !destination || !startDate || !endDate) {
    return { error: "Champs requis manquants", status: 400 };
  }

  const start = new Date(startDate);
  const end   = new Date(endDate);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (start >= end) {
    return { error: "La date de fin doit être après la date de début", status: 400 };
  }

  const startDay = new Date(start);
  startDay.setHours(0, 0, 0, 0);
  if (startDay < today) {
    return { error: "La date de début ne peut pas être dans le passé", status: 400 };
  }

  const trip = {
    title: title.trim(),
    description: description ? description.trim() : "",
    destination: destination.trim(),
    coverImage: coverImage || null,
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
  return { trip };
}

async function updateTrip(tripId, data, userId) {
  const db = getDb();
  const { trip, hasAccess } = await checkTripWriteAccess(db, tripId, userId);
  if (!trip)      return { error: "Voyage introuvable", status: 404 };
  if (!hasAccess) return { error: "Non autorisé à modifier ce voyage", status: 403 };

  const { title, description, destination, startDate, endDate, isPublic, status, visibility } = data;

  if (startDate && endDate && new Date(startDate) >= new Date(endDate)) {
    return { error: "La date de fin doit être après la date de début", status: 400 };
  }

  const updateData = { updatedAt: new Date() };
  if (title       !== undefined) updateData.title       = title.trim();
  if (description !== undefined) updateData.description = description.trim();
  if (destination !== undefined) updateData.destination = destination.trim();
  if (startDate   !== undefined) updateData.startDate   = new Date(startDate);
  if (endDate     !== undefined) updateData.endDate     = new Date(endDate);
  if (isPublic    !== undefined) updateData.isPublic    = isPublic;
  if (status      !== undefined) updateData.status      = status;
  if (visibility  !== undefined) updateData.visibility  = visibility;

  await db.collection("trips").updateOne({ _id: new ObjectId(tripId) }, { $set: updateData });
  const updated = await db.collection("trips").findOne({ _id: new ObjectId(tripId) });
  return { trip: updated };
}

async function deleteTrip(tripId, userId) {
  const db = getDb();
  const trip = await db.collection("trips").findOne({ _id: new ObjectId(tripId) });
  if (!trip) return { error: "Voyage introuvable", status: 404 };
  if (trip.ownerId !== userId) {
    return { error: "Seul le propriétaire peut supprimer ce voyage", status: 403 };
  }

  await Promise.all([
    db.collection("trips").deleteOne({ _id: new ObjectId(tripId) }),
    db.collection("bookings").deleteMany({ tripId }),
    db.collection("addresses").deleteMany({ tripId }),
    db.collection("invitations").deleteMany({ tripId }),
  ]);
  return { success: true };
}

async function removeTripCollaborator(tripId, targetUserId, requesterId) {
  const db = getDb();
  const trip = await db.collection("trips").findOne({ _id: new ObjectId(tripId) });
  if (!trip) return { error: "Voyage introuvable", status: 404 };
  if (trip.ownerId !== requesterId) {
    return { error: "Seul le propriétaire peut retirer des membres", status: 403 };
  }
  if (targetUserId === requesterId) {
    return { error: "Impossible de se retirer soi-même", status: 400 };
  }

  await db.collection("trips").updateOne(
    { _id: new ObjectId(tripId) },
    { $pull: { collaborators: { userId: targetUserId } } }
  );
  return { success: true };
}

async function transferTripOwnership(tripId, newOwnerId, requesterId) {
  const db = getDb();
  if (!newOwnerId) return { error: "newOwnerId requis", status: 400 };

  const trip = await db.collection("trips").findOne({ _id: new ObjectId(tripId) });
  if (!trip) return { error: "Voyage introuvable", status: 404 };
  if (trip.ownerId !== requesterId) {
    return { error: "Seul le propriétaire peut transférer la propriété", status: 403 };
  }

  const isCollaborator = trip.collaborators?.some((c) => c.userId === newOwnerId);
  if (!isCollaborator) {
    return { error: "Le nouveau propriétaire doit déjà être membre", status: 400 };
  }

  await db.collection("trips").updateOne(
    { _id: new ObjectId(tripId) },
    { $set: { ownerId: newOwnerId }, $pull: { collaborators: { userId: newOwnerId } } }
  );
  await db.collection("trips").updateOne(
    { _id: new ObjectId(tripId) },
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
  return { success: true };
}

module.exports = {
  getTripsForUser,
  getTripById,
  createTrip,
  updateTrip,
  deleteTrip,
  removeTripCollaborator,
  transferTripOwnership,
};
