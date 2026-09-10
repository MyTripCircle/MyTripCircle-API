const { ObjectId } = require("mongodb");
const { getDb } = require("../db");
const { getUserFeatures } = require("../utils/subscriptionHelper");
const {
  effectiveVisibility,
  isTripPublic,
  requestedVisibility,
  isValidVisibility,
} = require("../utils/tripVisibility");

/**
 * Opérations métier sur les voyages.
 *
 * Le voyage porte le modèle d'autorisation dont dépendent les adresses et les
 * réservations : il est la seule entité à définir un propriétaire, des
 * collaborateurs et une visibilité, les autres n'en font que dériver leurs
 * droits. Toute évolution de ce modèle se répercute donc sur l'ensemble du
 * domaine.
 *
 * Lecture et écriture sont résolues par deux fonctions distinctes plutôt que
 * par un contrôle paramétré. Elles ne diffèrent pas seulement par un degré : la
 * lecture admet la visibilité publique et le lien d'amitié, que l'écriture
 * ignore entièrement. Les fusionner rendrait probable qu'un assouplissement
 * pensé pour la lecture ouvre par mégarde un droit d'écriture.
 *
 * @module services/tripService
 */

/**
 * Établit le droit de lire un voyage.
 *
 * Quatre titres l'ouvrent : la propriété, la collaboration, la visibilité
 * publique et, pour la visibilité « amis », un lien d'amitié vérifié en base.
 * Ce dernier n'est évalué qu'en dernier recours, la lecture supplémentaire
 * qu'il impose étant inutile dès qu'un autre titre suffit.
 *
 * @param {import("mongodb").Db} db Base de données.
 * @param {string} tripId Identifiant du voyage.
 * @param {string} userId Identifiant du demandeur.
 * @returns {Promise<{ trip: object|null, hasAccess: boolean }>} Voyage et droit
 *   établi. Le document est rendu même en cas de refus, l'appelant devant
 *   distinguer l'absence du refus.
 */
async function checkTripReadAccess(db, tripId, userId) {
  const trip = await db.collection("trips").findOne({ _id: new ObjectId(tripId) });
  if (!trip) return { trip: null, hasAccess: false };

  const isOwner        = trip.ownerId === userId;
  const isCollaborator = trip.collaborators?.some((c) => c.userId === userId);

  if (isOwner || isCollaborator || isTripPublic(trip)) return { trip, hasAccess: true };

  if (trip.visibility === "friends") {
    const friendship = await db.collection("friends").findOne({ userId, friendId: trip.ownerId });
    return { trip, hasAccess: !!friendship };
  }
  return { trip, hasAccess: false };
}

/**
 * Établit le droit de modifier un voyage.
 *
 * Ni la visibilité publique ni le lien d'amitié n'entrent en compte : rendre un
 * voyage consultable est une décision de partage, jamais une délégation
 * d'écriture. Seuls le propriétaire et les collaborateurs explicitement dotés
 * de la permission d'édition sont admis.
 *
 * @param {import("mongodb").Db} db Base de données.
 * @param {string} tripId Identifiant du voyage.
 * @param {string} userId Identifiant du demandeur.
 * @returns {Promise<{ trip: object|null, hasAccess: boolean }>} Voyage et droit
 *   établi.
 */
async function checkTripWriteAccess(db, tripId, userId) {
  const trip = await db.collection("trips").findOne({ _id: new ObjectId(tripId) });
  if (!trip) return { trip: null, hasAccess: false };

  const isOwner        = trip.ownerId === userId;
  const isCollaborator = trip.collaborators?.some((c) => c.userId === userId && c.permissions.canEdit);
  return { trip, hasAccess: isOwner || isCollaborator };
}

/**
 * Complète une liste de voyages par leurs compteurs de contenu.
 *
 * Les compteurs sont recalculés par agrégation à la demande plutôt que
 * maintenus dans le document du voyage. Un compteur dénormalisé exigerait une
 * mise à jour à chaque écriture sur les réservations et les adresses, y compris
 * lors des suppressions en cascade, et dériverait de la réalité au premier
 * chemin oublié — sans que rien ne le signale, un compteur faux ayant
 * exactement l'apparence d'un compteur juste.
 *
 * Les deux agrégations portent sur l'ensemble des identifiants et sont lancées
 * de front, ce qui borne le coût à deux requêtes quel que soit le nombre de
 * voyages.
 *
 * @param {object[]} trips Voyages à compléter.
 * @param {import("mongodb").Db} db Base de données.
 * @returns {Promise<object[]>} Copies des voyages portant `stats`. L'entrée
 *   n'est pas modifiée.
 */
async function enrichTripsWithStats(trips, db) {
  if (trips.length === 0) return trips;
  const tripIds = trips.map((t) => t._id.toString());
  const [bookingCounts, addressCounts] = await Promise.all([
    db.collection("bookings").aggregate([
      { $match: { tripId: { $in: tripIds } } },
      { $group: { _id: "$tripId", count: { $sum: 1 } } },
    ]).toArray(),
    db.collection("addresses").aggregate([
      { $match: { tripId: { $in: tripIds } } },
      { $group: { _id: "$tripId", count: { $sum: 1 } } },
    ]).toArray(),
  ]);
  const bookingMap = new Map(bookingCounts.map((b) => [b._id, b.count]));
  const addressMap = new Map(addressCounts.map((a) => [a._id, a.count]));
  return trips.map((t) => ({
    ...t,
    stats: {
      totalBookings: bookingMap.get(t._id.toString()) ?? 0,
      totalAddresses: addressMap.get(t._id.toString()) ?? 0,
      totalCollaborators: t.collaborators?.length ?? 0,
    },
  }));
}

/**
 * Rend les voyages auxquels un utilisateur participe.
 *
 * Le périmètre se limite à la propriété et à la collaboration : les voyages
 * publics ou visibles entre amis sont consultables mais n'ont pas à encombrer
 * la liste personnelle, qui répond à la question de ce que l'utilisateur
 * organise et non de ce à quoi il a accès.
 *
 * @param {string} userId Identifiant de l'utilisateur.
 * @returns {Promise<object[]>} Voyages complétés de leurs compteurs. Tableau
 *   vide si aucun.
 * @throws {Error} Si la base n'est pas connectée.
 */
async function getTripsForUser(userId) {
  const db = getDb();
  const trips = await db.collection("trips").find({
    $or: [{ ownerId: userId }, { "collaborators.userId": userId }],
  }).toArray();
  return enrichTripsWithStats(trips, db);
}

/**
 * Rend un voyage par son identifiant, sous réserve d'un droit de lecture.
 *
 * @param {string} tripId Identifiant du voyage.
 * @param {string} userId Identifiant du demandeur.
 * @returns {Promise<{ trip: object } | { error: string, status: number }>}
 *   Voyage complété de ses compteurs, ou refus qualifié.
 * @throws {Error} Si la base n'est pas connectée.
 */
async function getTripById(tripId, userId) {
  const db = getDb();
  const { trip, hasAccess } = await checkTripReadAccess(db, tripId, userId);
  if (!trip) return { error: "Voyage introuvable", status: 404 };
  if (!hasAccess) return { error: "Accès refusé", status: 403 };
  const [enriched] = await enrichTripsWithStats([trip], db);
  return { trip: enriched };
}

/**
 * Crée un voyage pour le compte d'un utilisateur.
 *
 * Le quota de l'offre est vérifié côté serveur et non seulement dans
 * l'interface : c'est le seul contrôle qu'un appel direct à l'API ne contourne
 * pas. La convention `-1` désigne l'absence de limite et court-circuite le
 * comptage, qui serait sans objet.
 *
 * Les dates sont comparées après remise à minuit pour la borne de début : sans
 * cette normalisation, un voyage commençant le jour même serait refusé dès lors
 * que l'heure courante a dépassé minuit, c'est-à-dire toujours.
 *
 * La visibilité, lorsqu'elle n'est pas précisée, est déduite du drapeau public
 * et retombe sur « privé ». Le défaut restrictif est délibéré : un voyage rendu
 * public par omission ne se rattrape pas une fois consulté. Le drapeau est
 * ensuite recalculé depuis la visibilité retenue, pour que les deux champs ne
 * naissent jamais divergents.
 *
 * @param {object} data Données du voyage.
 * @param {string} userId Identifiant du propriétaire, issu du contexte
 *   authentifié.
 * @returns {Promise<{ trip: object } | { error: string, status: number }>}
 *   Voyage créé, ou erreur de validation, de quota ou de cohérence des dates.
 * @throws {Error} Si la base n'est pas connectée.
 */
async function createTrip(data, userId) {
  const db = getDb();
  const { title, description, destination, startDate, endDate, isPublic, visibility, tags, status, coverImage } = data;

  if (!title || !destination || !startDate || !endDate) {
    return { error: "Champs requis manquants", status: 400 };
  }

  const tripVisibility = requestedVisibility({ visibility, isPublic }) ?? "private";
  if (!isValidVisibility(tripVisibility)) {
    return { error: "Visibilité invalide", status: 400 };
  }

  const features = await getUserFeatures(db, userId);
  if (features.maxTrips !== -1) {
    const tripCount = await db.collection("trips").countDocuments({ ownerId: userId });
    if (tripCount >= features.maxTrips) {
      return {
        error: `Limite de ${features.maxTrips} voyages atteinte — passez à Premium pour en créer davantage`,
        status: 403,
      };
    }
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
    isPublic: tripVisibility === "public",
    visibility: tripVisibility,
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

/**
 * Met à jour un voyage.
 *
 * La contrainte de date antérieure imposée à la création n'est pas reprise
 * ici : un voyage en cours ou passé doit rester corrigible, et l'appliquer
 * empêcherait de rectifier après coup une saisie erronée. Seule la cohérence
 * entre début et fin reste vérifiée.
 *
 * Les champs modifiables sont énumérés explicitement ; propriété,
 * collaborateurs et compteurs en sont absents et relèvent d'opérations
 * dédiées, qui portent leurs propres contrôles.
 *
 * Deux décisions restent réservées au propriétaire, même face à un
 * collaborateur doté du droit d'édition : valider le voyage (le statut) et
 * changer sa visibilité. La première fige la planification pour tout le
 * cercle, la seconde décide de qui peut le lire ; ni l'une ni l'autre ne
 * relève d'une permission d'édition. Seul un changement effectif est refusé :
 * le formulaire d'édition renvoie ces champs inchangés à chaque enregistrement,
 * et un collaborateur doit pouvoir corriger un titre sans se heurter à un refus
 * (défaut D-23 du registre : cette règle n'était tenue que par l'interface).
 *
 * @param {string} tripId Identifiant du voyage.
 * @param {object} data Champs à modifier, tous facultatifs.
 * @param {string} userId Identifiant du demandeur.
 * @returns {Promise<{ trip: object } | { error: string, status: number }>}
 *   Voyage mis à jour, ou refus qualifié.
 * @throws {Error} Si la base n'est pas connectée.
 */
async function updateTrip(tripId, data, userId) {
  const db = getDb();
  const { trip, hasAccess } = await checkTripWriteAccess(db, tripId, userId);
  if (!trip)      return { error: "Voyage introuvable", status: 404 };
  if (!hasAccess) return { error: "Non autorisé à modifier ce voyage", status: 403 };

  const { title, description, destination, startDate, endDate, isPublic, status, visibility } = data;

  if (startDate && endDate && new Date(startDate) >= new Date(endDate)) {
    return { error: "La date de fin doit être après la date de début", status: 400 };
  }

  const nextVisibility = requestedVisibility({ visibility, isPublic });
  if (nextVisibility !== undefined && !isValidVisibility(nextVisibility)) {
    return { error: "Visibilité invalide", status: 400 };
  }

  const changesVisibility = nextVisibility !== undefined && nextVisibility !== effectiveVisibility(trip);
  const changesStatus     = status !== undefined && status !== trip.status;
  if ((changesVisibility || changesStatus) && trip.ownerId !== userId) {
    return { error: "Seul le propriétaire peut valider le voyage ou changer sa visibilité", status: 403 };
  }

  const updateData = { updatedAt: new Date() };
  if (title       !== undefined) updateData.title       = title.trim();
  if (description !== undefined) updateData.description = description.trim();
  if (destination !== undefined) updateData.destination = destination.trim();
  if (startDate   !== undefined) updateData.startDate   = new Date(startDate);
  if (endDate     !== undefined) updateData.endDate     = new Date(endDate);
  if (status      !== undefined) updateData.status      = status;
  if (nextVisibility !== undefined) {
    updateData.visibility = nextVisibility;
    updateData.isPublic   = nextVisibility === "public";
  }

  await db.collection("trips").updateOne({ _id: new ObjectId(tripId) }, { $set: updateData });
  const updated = await db.collection("trips").findOne({ _id: new ObjectId(tripId) });
  return { trip: updated };
}

/**
 * Supprime un voyage et tout ce qui s'y rattache.
 *
 * Réservé au propriétaire, sans égard aux permissions accordées : la
 * suppression détruit aussi le travail des collaborateurs, ce qu'une permission
 * d'édition ne saurait autoriser.
 *
 * Réservations, adresses et invitations sont supprimées dans le même passage.
 * Les laisser subsisterait sous forme de documents rattachés à un voyage
 * disparu, invisibles de l'interface mais toujours présents en base — des
 * données personnelles conservées sans finalité ni moyen de les atteindre.
 *
 * @param {string} tripId Identifiant du voyage.
 * @param {string} userId Identifiant du demandeur, qui doit être le
 *   propriétaire.
 * @returns {Promise<{ success: true } | { error: string, status: number }>}
 *   Confirmation, ou refus qualifié.
 * @throws {Error} Si la base n'est pas connectée.
 */
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

/**
 * Retire un collaborateur d'un voyage.
 *
 * Réservé au propriétaire. Le retrait de soi-même est refusé : le propriétaire
 * ne figure pas parmi les collaborateurs, la demande traduit donc une confusion
 * dont l'aboutissement laisserait le voyage sans responsable identifié. Quitter
 * la propriété passe par {@link transferTripOwnership}.
 *
 * Les contenus créés par le collaborateur sont conservés : ils appartiennent au
 * voyage, dont le propriétaire reste titulaire.
 *
 * @param {string} tripId Identifiant du voyage.
 * @param {string} targetUserId Identifiant du collaborateur à retirer.
 * @param {string} requesterId Identifiant du demandeur, qui doit être le
 *   propriétaire.
 * @returns {Promise<{ success: true } | { error: string, status: number }>}
 *   Confirmation, ou refus qualifié.
 * @throws {Error} Si la base n'est pas connectée.
 */
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

/**
 * Transfère la propriété d'un voyage à un collaborateur existant.
 *
 * Le bénéficiaire doit déjà être membre. Cette exigence évite qu'un voyage soit
 * remis à un identifiant arbitraire — compte inexistant, ou tiers n'ayant
 * jamais consenti à en prendre la charge — ce qui le rendrait définitivement
 * ingérable, la propriété étant la seule voie de suppression.
 *
 * L'ancien propriétaire est rétrogradé en éditeur plutôt qu'exclu : il perdrait
 * autrement l'accès au voyage qu'il a constitué. La permission de suppression
 * ne lui est pas laissée, celle-ci suivant désormais la propriété.
 *
 * L'opération se déroule en deux mises à jour successives, la seconde
 * réintroduisant le demandeur parmi les collaborateurs. L'ordre importe : une
 * modification concurrente entre les deux laisserait le voyage privé de son
 * ancien propriétaire, situation moins dommageable qu'un voyage sans
 * propriétaire.
 *
 * @param {string} tripId Identifiant du voyage.
 * @param {string} newOwnerId Identifiant du nouveau propriétaire, qui doit
 *   figurer parmi les collaborateurs.
 * @param {string} requesterId Identifiant du demandeur, qui doit être le
 *   propriétaire courant.
 * @returns {Promise<{ success: true } | { error: string, status: number }>}
 *   Confirmation, ou refus qualifié.
 * @throws {Error} Si la base n'est pas connectée.
 */
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
