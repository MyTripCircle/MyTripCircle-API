const { ObjectId } = require("mongodb");
const { getDb } = require("../db");
const { encryptAddressFields, decryptAddressFields } = require("../utils/crypto");

const VALID_TYPES = ["hotel", "restaurant", "activity", "transport", "other"];
const trim = (v) => (typeof v === "string" ? v.trim() : v);

function isValidHttpUrl(url) {
  try {
    const u = new URL(url);
    return ["http:", "https:"].includes(u.protocol);
  } catch {
    return false;
  }
}

function isInvalidStringField(value, maxLen) {
  return typeof value !== "string" || value.trim().length === 0 || value.trim().length > maxLen;
}

function hasInvalidUrl(url) {
  return url && !isValidHttpUrl(url);
}

function applyOptionalField(setData, unsetData, key, val) {
  if (val !== undefined) {
    if (val) setData[key] = trim(val);
    else unsetData[key] = "";
  }
}

function applyRatingUpdate(setData, unsetData, rating) {
  if (rating !== undefined) {
    if (typeof rating === "number") setData.rating = rating;
    else unsetData.rating = "";
  }
}

function validateAddressCreate({ type, name, address, city, country, rating, website, photoUrl }) {
  if (!type || !VALID_TYPES.includes(type)) {
    return `Type invalide. Valeurs acceptées : ${VALID_TYPES.join(", ")}`;
  }
  if (!name || isInvalidStringField(name, 200))    return "Nom requis (1-200 caractères)";
  if (!address || isInvalidStringField(address, 500)) return "Adresse requise (1-500 caractères)";
  if (!city || isInvalidStringField(city, 100))    return "Ville requise (1-100 caractères)";
  if (!country || isInvalidStringField(country, 100)) return "Pays requis (1-100 caractères)";
  if (rating !== undefined && (typeof rating !== "number" || rating < 0 || rating > 5)) {
    return "Note invalide (0-5)";
  }
  if (hasInvalidUrl(website))  return "URL du site invalide";
  if (hasInvalidUrl(photoUrl)) return "URL de la photo invalide";
  return null;
}

function validateAddressUpdate({ type, name, address, city, country, rating, website, photoUrl }) {
  if (type !== undefined && !VALID_TYPES.includes(type)) {
    return `Type invalide. Valeurs acceptées : ${VALID_TYPES.join(", ")}`;
  }
  if (name    !== undefined && isInvalidStringField(name, 200))    return "Nom invalide (1-200 caractères)";
  if (address !== undefined && isInvalidStringField(address, 500)) return "Adresse invalide (1-500 caractères)";
  if (city    !== undefined && isInvalidStringField(city, 100))    return "Ville invalide (1-100 caractères)";
  if (country !== undefined && isInvalidStringField(country, 100)) return "Pays invalide (1-100 caractères)";
  if (rating  !== undefined && rating !== null && (typeof rating !== "number" || rating < 0 || rating > 5)) {
    return "Note invalide (0-5)";
  }
  if (hasInvalidUrl(website))  return "URL du site invalide";
  if (hasInvalidUrl(photoUrl)) return "URL de la photo invalide";
  return null;
}

async function checkEditAccess(db, id, userId) {
  const existing = await db.collection("addresses").findOne({ _id: new ObjectId(id) });
  if (!existing) return { status: 404, error: "Adresse introuvable" };
  if (existing.userId === userId) return { existing };
  if (existing.tripId) {
    const trip = await db.collection("trips").findOne({ _id: new ObjectId(existing.tripId) });
    const canEdit =
      trip &&
      (trip.ownerId === userId ||
        trip.collaborators?.some((c) => c.userId === userId && c.permissions.canEdit));
    if (canEdit) return { existing };
  }
  return { status: 403, error: "Accès refusé" };
}

async function getAddressesForUser(userId) {
  const db = getDb();
  const userTrips = await db.collection("trips").find({
    $or: [{ ownerId: userId }, { "collaborators.userId": userId }],
  }).project({ _id: 1 }).toArray();
  const tripIds = userTrips.map((t) => String(t._id));

  const items = await db.collection("addresses").find({
    $or: [{ tripId: { $in: tripIds } }, { userId }],
  }).toArray();
  return items.map(decryptAddressFields);
}

async function getAddressesByTripId(tripId, userId) {
  const db = getDb();
  const trip = await db.collection("trips").findOne({ _id: new ObjectId(tripId) });
  if (!trip) return { error: "Voyage introuvable", status: 404 };

  const isOwner        = trip.ownerId === userId;
  const isCollaborator = trip.collaborators?.some((c) => c.userId === userId);
  const isPublic       = trip.isPublic || trip.visibility === "public";

  if (!isOwner && !isCollaborator && !isPublic) {
    if (trip.visibility === "friends") {
      const friendship = await db.collection("friends").findOne({ userId, friendId: trip.ownerId });
      if (!friendship) return { error: "Accès refusé", status: 403 };
    } else {
      return { error: "Accès refusé", status: 403 };
    }
  }

  const items = await db.collection("addresses").find({ tripId }).toArray();
  return { items: items.map(decryptAddressFields) };
}

async function getAddressById(id, userId) {
  const db = getDb();
  const item = await db.collection("addresses").findOne({ _id: new ObjectId(id) });
  if (!item) return { error: "Adresse introuvable", status: 404 };

  const isOwner = item.userId === userId;
  if (!isOwner && item.tripId) {
    const trip = await db.collection("trips").findOne({ _id: new ObjectId(item.tripId) });
    const hasTripAccess =
      trip &&
      (trip.ownerId === userId || trip.collaborators?.some((c) => c.userId === userId));
    if (!hasTripAccess) return { error: "Accès refusé", status: 403 };
  } else if (!isOwner) {
    return { error: "Accès refusé", status: 403 };
  }
  return { item: decryptAddressFields(item) };
}

async function createAddress(data, userId) {
  const db = getDb();
  const validationError = validateAddressCreate(data);
  if (validationError) return { error: validationError, status: 400 };

  const { type, name, address, city, country, phone, website, notes, rating, tripId, photoUrl } = data;
  const doc = encryptAddressFields({
    type,
    name:    trim(name),
    address: trim(address),
    city:    trim(city),
    country: trim(country),
    phone:    phone    ? trim(phone)    : undefined,
    website:  website  ? trim(website)  : undefined,
    notes:    notes    ? trim(notes)    : undefined,
    rating:   typeof rating === "number" ? rating : undefined,
    photoUrl: photoUrl ? trim(photoUrl) : undefined,
    tripId:   tripId   || undefined,
    userId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const result = await db.collection("addresses").insertOne(doc);
  doc._id = result.insertedId;
  return { item: decryptAddressFields(doc) };
}

async function updateAddress(id, data, userId) {
  const db = getDb();
  const access = await checkEditAccess(db, id, userId);
  if (access.error) return { error: access.error, status: access.status };

  const updateError = validateAddressUpdate(data);
  if (updateError) return { error: updateError, status: 400 };

  const { type, name, address, city, country, phone, website, notes, rating, photoUrl } = data;
  const setData   = { updatedAt: new Date() };
  const unsetData = {};

  if (type    !== undefined) setData.type    = type;
  // RGPD Art. 32 — chiffrement des champs sensibles avant persistence
  if (name    !== undefined) setData.name    = encryptAddressFields({ name: trim(name) }).name;
  if (address !== undefined) setData.address = encryptAddressFields({ address: trim(address) }).address;
  if (city    !== undefined) setData.city    = trim(city);
  if (country !== undefined) setData.country = trim(country);

  for (const [key, val] of [["phone", phone], ["website", website], ["notes", notes], ["photoUrl", photoUrl]]) {
    applyOptionalField(setData, unsetData, key, val);
  }
  applyRatingUpdate(setData, unsetData, rating);

  const updatePayload = {};
  if (Object.keys(setData).length > 0)   updatePayload.$set   = setData;
  if (Object.keys(unsetData).length > 0) updatePayload.$unset = unsetData;

  await db.collection("addresses").updateOne({ _id: new ObjectId(id) }, updatePayload);
  const updated = await db.collection("addresses").findOne({ _id: new ObjectId(id) });
  return { item: decryptAddressFields(updated) };
}

async function deleteAddress(id, userId) {
  const db = getDb();
  const address = await db.collection("addresses").findOne({ _id: new ObjectId(id) });
  if (!address) return { error: "Adresse introuvable", status: 404 };

  const isCreator = address.userId === userId;
  if (!isCreator && address.tripId) {
    const trip = await db.collection("trips").findOne({ _id: new ObjectId(address.tripId) });
    const canDelete =
      trip &&
      (trip.ownerId === userId ||
        trip.collaborators?.some((c) => c.userId === userId && c.permissions.canDelete));
    if (!canDelete) return { error: "Accès refusé", status: 403 };
  } else if (!isCreator) {
    return { error: "Accès refusé", status: 403 };
  }

  await db.collection("addresses").deleteOne({ _id: new ObjectId(id) });
  return { success: true };
}

module.exports = {
  getAddressesForUser,
  getAddressesByTripId,
  getAddressById,
  createAddress,
  updateAddress,
  deleteAddress,
};
