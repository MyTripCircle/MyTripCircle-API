const { ObjectId } = require("mongodb");
const { getDb } = require("../db");
const { encryptAddressFields, decryptAddressFields } = require("../utils/crypto");

/**
 * Opérations métier sur les adresses d'un carnet de voyage.
 *
 * Les fonctions publiques de ce module rendent une issue — `{ item }` ou
 * `{ error, status }` — plutôt que d'émettre une erreur sur refus. Un accès
 * refusé et une ressource introuvable sont des réponses attendues du domaine,
 * pas des défaillances ; les traiter comme des exceptions confondrait le cas
 * nominal avec l'incident et laisserait le contrôle de la réponse HTTP au
 * gestionnaire d'erreurs global, qui ne saurait pas distinguer les deux.
 *
 * Le chiffrement et le déchiffrement sont assurés à cette frontière : les
 * routes appelantes ne voient que du clair, et aucune donnée d'adresse ne peut
 * atteindre la base sans être passée par ici.
 *
 * @module services/addressService
 */

const VALID_TYPES = ["hotel", "restaurant", "activity", "transport", "other"];
const trim = (v) => (typeof v === "string" ? v.trim() : v);

/**
 * Vérifie qu'une URL est exploitable et repose sur un schéma autorisé.
 *
 * La liste blanche de schémas est le point essentiel : ces URL sont restituées
 * au client, qui les rend cliquables. Sans elle, une valeur en `javascript:` ou
 * en `data:` stockée par un utilisateur s'exécuterait dans le contexte de
 * l'application chez quiconque consulte le voyage partagé. Une validation
 * portant sur la seule forme générale ne l'écarterait pas.
 *
 * @param {string} url Valeur candidate.
 * @returns {boolean} Vrai si l'URL est analysable et en `http:` ou `https:`.
 */
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

/**
 * Répartit un champ facultatif entre les opérateurs `$set` et `$unset`.
 *
 * Trois intentions doivent être distinguées dans une mise à jour partielle :
 * champ absent de la requête, donc inchangé ; champ renseigné, donc écrit ;
 * champ vidé, donc retiré du document. Écrire une chaîne vide au lieu de
 * retirer la propriété laisserait un champ présent mais creux, que les
 * consommateurs devraient ensuite traiter comme une absence.
 *
 * @param {object} setData Accumulateur des champs à écrire.
 * @param {object} unsetData Accumulateur des champs à retirer.
 * @param {string} key Nom du champ.
 * @param {*} val Valeur reçue ; `undefined` laisse le champ intact.
 * @returns {void}
 */
function applyOptionalField(setData, unsetData, key, val) {
  if (val !== undefined) {
    if (val) setData[key] = trim(val);
    else unsetData[key] = "";
  }
}

/**
 * Répartit la note entre écriture et retrait.
 *
 * Traitée à part de {@link applyOptionalField} parce que zéro est une note
 * recevable : le test de véracité appliqué aux champs textuels la confondrait
 * avec une valeur vide et effacerait une note délibérément mise au minimum.
 * Le contrôle porte donc sur le type et non sur la valeur.
 *
 * @param {object} setData Accumulateur des champs à écrire.
 * @param {object} unsetData Accumulateur des champs à retirer.
 * @param {*} rating Note reçue ; `undefined` la laisse intacte, toute valeur
 *   non numérique la retire.
 * @returns {void}
 */
function applyRatingUpdate(setData, unsetData, rating) {
  if (rating !== undefined) {
    if (typeof rating === "number") setData.rating = rating;
    else unsetData.rating = "";
  }
}

/**
 * Valide les données d'une création d'adresse.
 *
 * Les longueurs maximales sont contrôlées ici et non déléguées au validateur
 * MongoDB : les champs concernés sont chiffrés avant écriture, et le validateur
 * ne verrait donc que la longueur du cryptogramme, sans rapport avec celle de
 * la saisie. Cette vérification est le seul endroit où la borne est encore
 * observable.
 *
 * @param {object} data Données soumises.
 * @returns {string|null} Message d'erreur destiné au client, ou `null` si les
 *   données sont recevables.
 */
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

/**
 * Valide les données d'une mise à jour partielle d'adresse.
 *
 * Distincte de {@link validateAddressCreate} parce qu'une mise à jour ne porte
 * que sur les champs transmis : un champ absent est licite ici alors qu'il
 * serait manquant à la création. Fusionner les deux jeux de règles rendrait
 * l'un des deux cas incorrect.
 *
 * La note admet en outre `null`, forme par laquelle le client demande son
 * effacement.
 *
 * @param {object} data Données soumises, tous champs facultatifs.
 * @returns {string|null} Message d'erreur destiné au client, ou `null` si les
 *   données sont recevables.
 */
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

/**
 * Établit le droit de modifier une adresse.
 *
 * Deux titres distincts ouvrent ce droit : être l'auteur de l'adresse, ou
 * disposer de la permission d'édition sur le voyage auquel elle est rattachée.
 * Le second est nécessaire au travail collaboratif — une adresse ajoutée par un
 * membre resterait sinon figée pour tous les autres — mais il ne s'étend pas
 * aux adresses personnelles, celles sans voyage associé.
 *
 * L'issue distingue l'absence de la ressource du refus d'accès. Cette
 * distinction est admise ici parce que les identifiants d'adresse ne sont pas
 * devinables et ne circulent qu'entre membres du même voyage : elle ne
 * renseigne pas un tiers sur l'existence de contenus qu'il ignore.
 *
 * @param {import("mongodb").Db} db Base de données.
 * @param {string} id Identifiant de l'adresse.
 * @param {string} userId Identifiant du demandeur.
 * @returns {Promise<{ existing: object } | { status: number, error: string }>}
 *   Document existant si le droit est établi, refus qualifié sinon.
 */
async function checkEditAccess(db, id, userId) {
  const existing = await db.collection("addresses").findOne({ _id: new ObjectId(String(id)) });
  if (!existing) return { status: 404, error: "Adresse introuvable" };
  if (existing.userId === userId) return { existing };
  if (existing.tripId) {
    const trip = await db.collection("trips").findOne({ _id: new ObjectId(String(existing.tripId)) });
    const canEdit =
      trip &&
      (trip.ownerId === userId ||
        trip.collaborators?.some((c) => c.userId === userId && c.permissions.canEdit));
    if (canEdit) return { existing };
  }
  return { status: 403, error: "Accès refusé" };
}

/**
 * Rend les adresses accessibles à un utilisateur.
 *
 * Le périmètre couvre les adresses personnelles et celles des voyages dont
 * l'utilisateur est propriétaire ou collaborateur. Les identifiants de voyage
 * sont d'abord rassemblés, puis employés comme filtre : la sélection est ainsi
 * faite par la base et non après coup en mémoire, ce qui évite de charger des
 * documents qui seraient ensuite écartés.
 *
 * @param {string} userId Identifiant de l'utilisateur.
 * @returns {Promise<object[]>} Adresses déchiffrées. Tableau vide si aucune.
 * @throws {Error} Si la base n'est pas connectée ou si les clés de chiffrement
 *   sont absentes.
 */
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

/**
 * Rend les adresses d'un voyage, sous réserve d'un droit de lecture.
 *
 * Le droit est réévalué à chaque appel plutôt que déduit du fait que le client
 * connaît l'identifiant du voyage : celui-ci a pu être partagé, ou la
 * visibilité restreinte depuis. La visibilité « amis » impose une vérification
 * supplémentaire en base, le lien d'amitié pouvant avoir été rompu après la
 * dernière consultation.
 *
 * @param {string} tripId Identifiant du voyage.
 * @param {string} userId Identifiant du demandeur.
 * @returns {Promise<{ items: object[] } | { error: string, status: number }>}
 *   Adresses déchiffrées, ou refus qualifié.
 * @throws {Error} Si la base n'est pas connectée ou si les clés de chiffrement
 *   sont absentes.
 */
async function getAddressesByTripId(tripId, userId) {
  const db = getDb();
  const trip = await db.collection("trips").findOne({ _id: new ObjectId(String(tripId)) });
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

/**
 * Rend une adresse par son identifiant, sous réserve d'un droit de lecture.
 *
 * Le droit se transmet par le voyage de rattachement : les collaborateurs
 * accèdent en lecture aux adresses du voyage sans distinction d'auteur. Une
 * adresse personnelle, dépourvue de rattachement, n'est visible que de son
 * auteur.
 *
 * @param {string} id Identifiant de l'adresse.
 * @param {string} userId Identifiant du demandeur.
 * @returns {Promise<{ item: object } | { error: string, status: number }>}
 *   Adresse déchiffrée, ou refus qualifié.
 * @throws {Error} Si la base n'est pas connectée ou si les clés de chiffrement
 *   sont absentes.
 */
async function getAddressById(id, userId) {
  const db = getDb();
  const item = await db.collection("addresses").findOne({ _id: new ObjectId(String(id)) });
  if (!item) return { error: "Adresse introuvable", status: 404 };

  const isOwner = item.userId === userId;
  if (!isOwner && item.tripId) {
    const trip = await db.collection("trips").findOne({ _id: new ObjectId(String(item.tripId)) });
    const hasTripAccess =
      trip &&
      (trip.ownerId === userId || trip.collaborators?.some((c) => c.userId === userId));
    if (!hasTripAccess) return { error: "Accès refusé", status: 403 };
  } else if (!isOwner) {
    return { error: "Accès refusé", status: 403 };
  }
  return { item: decryptAddressFields(item) };
}

/**
 * Crée une adresse pour le compte d'un utilisateur.
 *
 * L'identifiant du propriétaire provient du contexte authentifié et non des
 * données soumises : l'accepter du client permettrait d'inscrire une adresse
 * sous l'identité d'autrui.
 *
 * Le document rendu est reconstruit à partir de celui qui vient d'être écrit,
 * puis déchiffré, plutôt que relu en base. La relecture n'apporterait rien ici
 * et la valeur rendue reste conforme à ce qui a été persisté.
 *
 * @param {object} data Données de l'adresse, champs sensibles en clair.
 * @param {string} userId Identifiant du créateur, issu du contexte
 *   authentifié.
 * @returns {Promise<{ item: object } | { error: string, status: number }>}
 *   Adresse créée et déchiffrée, ou erreur de validation.
 * @throws {Error} Si la base n'est pas connectée ou si les clés de chiffrement
 *   sont absentes.
 */
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

/**
 * Met à jour une adresse existante.
 *
 * Le droit d'écriture est vérifié avant la validation des données : un
 * utilisateur sans droit doit recevoir un refus, jamais un message d'erreur de
 * saisie qui lui apprendrait la forme attendue d'une ressource qu'il ne peut
 * pas modifier.
 *
 * Seuls les champs transmis sont touchés, les autres restent en l'état. Les
 * champs sensibles repassent par le chiffrement avant écriture : les recopier
 * tels quels depuis la requête les laisserait en clair en base.
 *
 * @param {string} id Identifiant de l'adresse.
 * @param {object} data Champs à modifier, tous facultatifs.
 * @param {string} userId Identifiant du demandeur.
 * @returns {Promise<{ item: object } | { error: string, status: number }>}
 *   Adresse mise à jour et déchiffrée, ou refus qualifié.
 * @throws {Error} Si la base n'est pas connectée ou si les clés de chiffrement
 *   sont absentes.
 */
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

  await db.collection("addresses").updateOne({ _id: new ObjectId(String(id)) }, updatePayload);
  const updated = await db.collection("addresses").findOne({ _id: new ObjectId(String(id)) });
  return { item: decryptAddressFields(updated) };
}

/**
 * Supprime une adresse.
 *
 * La permission requise est `canDelete` et non `canEdit` : la suppression est
 * irréversible là où une modification se corrige, ce qui justifie un droit
 * distinct. L'auteur de l'adresse conserve la sienne indépendamment des
 * permissions accordées sur le voyage.
 *
 * @param {string} id Identifiant de l'adresse.
 * @param {string} userId Identifiant du demandeur.
 * @returns {Promise<{ success: true } | { error: string, status: number }>}
 *   Confirmation, ou refus qualifié.
 * @throws {Error} Si la base n'est pas connectée.
 */
async function deleteAddress(id, userId) {
  const db = getDb();
  const address = await db.collection("addresses").findOne({ _id: new ObjectId(String(id)) });
  if (!address) return { error: "Adresse introuvable", status: 404 };

  const isCreator = address.userId === userId;
  if (!isCreator && address.tripId) {
    const trip = await db.collection("trips").findOne({ _id: new ObjectId(String(address.tripId)) });
    const canDelete =
      trip &&
      (trip.ownerId === userId ||
        trip.collaborators?.some((c) => c.userId === userId && c.permissions.canDelete));
    if (!canDelete) return { error: "Accès refusé", status: 403 };
  } else if (!isCreator) {
    return { error: "Accès refusé", status: 403 };
  }

  await db.collection("addresses").deleteOne({ _id: new ObjectId(String(id)) });
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
