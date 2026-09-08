const { ObjectId } = require("mongodb");
const { getDb } = require("../db");

/**
 * Opérations métier sur les réservations d'un voyage.
 *
 * Une réservation existe sous deux régimes : rattachée à un voyage, elle en
 * suit les droits d'accès et devient visible des collaborateurs ; autonome,
 * elle reste privée à son auteur. Chaque fonction distingue ces deux cas, car
 * appliquer les droits du voyage à une réservation autonome exposerait des
 * données personnelles — numéros de confirmation, montants — que l'utilisateur
 * n'a jamais entendu partager.
 *
 * Comme les autres services, les refus sont rendus sous forme d'issue
 * `{ error, status }` et non émis comme erreurs.
 *
 * @module services/bookingService
 */

/**
 * Établit le droit de lire le contenu d'un voyage.
 *
 * La visibilité « amis » impose une lecture supplémentaire pour vérifier le
 * lien : il est rompu unilatéralement et sans notification, l'évaluer à la
 * demande est donc le seul moyen d'en tenir compte immédiatement.
 *
 * @param {import("mongodb").Db} db Base de données.
 * @param {string} tripId Identifiant du voyage.
 * @param {string} userId Identifiant du demandeur.
 * @returns {Promise<boolean>} Vrai si la lecture est permise. Faux si le voyage
 *   n'existe pas, l'absence ne devant pas ouvrir de droit par défaut.
 */
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

/**
 * Rend les réservations accessibles à un utilisateur.
 *
 * Le filtre énumère explicitement les trois formes que prend une réservation
 * autonome — rattachement vide, nul, ou propriété absente — parce que ces trois
 * états coexistent en base selon la version qui a produit le document. Un
 * filtre ne couvrant qu'une de ces formes ferait disparaître de la liste des
 * réservations pourtant existantes, sans erreur visible.
 *
 * @param {string} userId Identifiant de l'utilisateur.
 * @returns {Promise<object[]>} Réservations. Tableau vide si aucune.
 * @throws {Error} Si la base n'est pas connectée.
 */
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

/**
 * Rend les réservations d'un voyage, sous réserve d'un droit de lecture.
 *
 * Un voyage introuvable est rendu comme un accès refusé et non comme une
 * absence : à ce niveau, distinguer les deux permettrait de sonder l'existence
 * de voyages appartenant à d'autres.
 *
 * @param {string} tripId Identifiant du voyage.
 * @param {string} userId Identifiant du demandeur.
 * @returns {Promise<{ items: object[] } | { error: string, status: number }>}
 *   Réservations, ou refus qualifié.
 * @throws {Error} Si la base n'est pas connectée.
 */
async function getBookingsByTripId(tripId, userId) {
  const db = getDb();
  const hasAccess = await checkTripReadAccess(db, tripId, userId);
  if (!hasAccess) return { error: "Accès refusé", status: 403 };
  const items = await db.collection("bookings").find({ tripId }).toArray();
  return { items };
}

/**
 * Rend une réservation par son identifiant, sous réserve d'un droit de lecture.
 *
 * Pour une réservation rattachée, l'auteur conserve l'accès même si le droit de
 * lecture sur le voyage lui a été retiré depuis : la réservation est sa propre
 * donnée, une exclusion du voyage ne doit pas l'en priver.
 *
 * @param {string} id Identifiant de la réservation.
 * @param {string} userId Identifiant du demandeur.
 * @returns {Promise<{ booking: object } | { error: string, status: number }>}
 *   Réservation, ou refus qualifié.
 * @throws {Error} Si la base n'est pas connectée.
 */
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

/**
 * Crée une réservation.
 *
 * Le document est composé champ par champ à partir des données reçues, jamais
 * par recopie du corps de requête. Une recopie laisserait un client fixer
 * `userId` ou `_id` et inscrire une réservation sous l'identité d'un autre, ou
 * écraser un document existant.
 *
 * Un rattachement absent est normalisé en chaîne vide plutôt que laissé
 * indéfini, afin que le document créé prenne l'une des formes que le filtre de
 * {@link getBookingsForUser} sait reconnaître.
 *
 * @param {object} data Données de la réservation.
 * @param {string} userId Identifiant du créateur, issu du contexte
 *   authentifié.
 * @returns {Promise<{ booking: object } | { error: string, status: number }>}
 *   Réservation créée, ou erreur de validation.
 * @throws {Error} Si la base n'est pas connectée.
 */
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

/**
 * Établit le droit d'écrire sur une réservation.
 *
 * La permission à contrôler est passée en paramètre plutôt que fixée, de sorte
 * que modification et suppression partagent la même logique de résolution sans
 * la dupliquer. Dupliquer ce parcours exposerait à ce qu'une correction
 * ultérieure n'en atteigne qu'une des deux copies.
 *
 * Le document est rendu même lorsque le droit est refusé : l'appelant a besoin
 * de distinguer l'absence de ressource du refus pour choisir entre 404 et 403.
 *
 * @param {import("mongodb").Db} db Base de données.
 * @param {string} id Identifiant de la réservation.
 * @param {string} userId Identifiant du demandeur.
 * @param {"canEdit"|"canDelete"} [permissionKey="canEdit"] Permission requise
 *   sur le voyage de rattachement.
 * @returns {Promise<{ booking: object|null, hasAccess: boolean }>} Document et
 *   droit établi.
 */
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

/**
 * Met à jour une réservation.
 *
 * Les champs modifiables sont énumérés en liste blanche. Sans elle, un client
 * pourrait glisser `userId` dans sa requête et transférer la réservation à un
 * tiers, ou réécrire `createdAt` pour en fausser l'historique. Un champ ajouté
 * plus tard au modèle restera non modifiable tant qu'il n'aura pas été inscrit
 * ici, ce qui est le comportement sûr par défaut.
 *
 * @param {string} id Identifiant de la réservation.
 * @param {object} data Champs à modifier, tous facultatifs.
 * @param {string} userId Identifiant du demandeur.
 * @returns {Promise<{ booking: object } | { error: string, status: number }>}
 *   Réservation mise à jour, ou refus qualifié.
 * @throws {Error} Si la base n'est pas connectée.
 */
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

/**
 * Supprime une réservation.
 *
 * La permission `canDelete` est requise, distincte de celle qui autorise la
 * modification : perdre un numéro de confirmation ou une référence de vol n'a
 * pas d'équivalent réversible.
 *
 * @param {string} id Identifiant de la réservation.
 * @param {string} userId Identifiant du demandeur.
 * @returns {Promise<{ success: true } | { error: string, status: number }>}
 *   Confirmation, ou refus qualifié.
 * @throws {Error} Si la base n'est pas connectée.
 */
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
