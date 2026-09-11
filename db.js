/**
 * Point d'accès unique à MongoDB.
 *
 * Le reste du serveur n'ouvre jamais de connexion : il appelle {@link getDb}.
 * Cette contrainte tient la mise en place du schéma et des index en un seul
 * endroit — une connexion ouverte ailleurs contournerait silencieusement les
 * garanties posées ici — et permet de refermer proprement le client en fin de
 * suite de tests.
 *
 * Les durées de conservation sont portées par des index TTL plutôt que par une
 * tâche planifiée applicative. Le moteur applique l'expiration même serveur
 * applicatif arrêté ou redéployé, ce qu'une tâche en processus ne garantit pas ;
 * la conservation devient une propriété de la base, opposable telle quelle lors
 * d'un contrôle, et non une promesse dépendant de la disponibilité d'un
 * processus. Le nettoyage résiduel confié à `utils/cleanupJob` couvre les seuls
 * cas qu'un TTL ne sait pas exprimer, à savoir les suppressions en cascade
 * entre collections.
 *
 * @module db
 */

const { MongoClient } = require("mongodb");
const { MONGODB_URI, DB_NAME } = require("./config");
const logger = require("./utils/logger");

/**
 * Durée de vie du cache d'itinéraires générés.
 *
 * Sept jours : au-delà, les informations pratiques d'une destination (horaires,
 * ouvertures, tarifs) ont assez dérivé pour qu'un itinéraire resservi induise
 * l'utilisateur en erreur. En deçà, le bénéfice du cache sur le coût de
 * génération s'effondre.
 */
const TTL_ITINERARY_CACHE_S = 604800;  // 7 jours

/**
 * Durée de vie des enregistrements de comptage d'usage.
 *
 * Vingt-quatre heures : ces enregistrements ne servent qu'à faire respecter un
 * quota journalier de génération. Passé la fenêtre qu'ils mesurent, ils
 * n'apportent plus rien et deviennent une trace d'activité conservée sans
 * finalité, que le TTL supprime au titre de la minimisation.
 */
const TTL_ITINERARY_USAGE_S = 86400;   // 24 heures

/**
 * Contrat de données de la collection `users`, appliqué par le moteur.
 *
 * Seuls `name` et `createdAt` sont exigés : ce sont les deux champs présents
 * quel que soit le mode d'inscription. L'adresse électronique ne l'est pas,
 * Sign in with Apple pouvant ne pas la transmettre. Aucun motif n'est posé sur
 * son format : elle est stockée chiffrée (`iv:tag:données`), et un motif
 * d'adresse rejetterait précisément les documents conformes. Le schéma
 * contraint le type des champs que le serveur écrit et laisse libres les
 * autres, pour qu'une fonctionnalité nouvelle n'exige pas de migrer le
 * validateur.
 */
const USERS_SCHEMA = {
  bsonType: "object",
  required: ["name", "createdAt"],
  properties: {
    name: { bsonType: "string" },
    email: { bsonType: ["string", "null"] },
    emailHash: { bsonType: "string" },
    phone: { bsonType: ["string", "null"] },
    phoneHash: { bsonType: ["string", "null"] },
    password: { bsonType: "string" },
    verified: { bsonType: "bool" },
    createdAt: { bsonType: "date" },
    updatedAt: { bsonType: "date" },
  },
};

/**
 * Champs que le serveur peut écrire à `null`, et qu'un validateur existant
 * doit donc accepter à `null`.
 *
 * `phone` : l'utilisateur peut effacer son numéro.
 * `email` : Sign in with Apple peut ne pas transmettre d'adresse ; un
 * validateur qui refuse `null` fait alors échouer l'inscription en erreur
 * serveur (défaut D-24).
 */
const NULLABLE_USER_FIELDS = ["phone", "email"];

let db;
let client;

/**
 * Ouvre la connexion, puis met la base en conformité avec le schéma attendu.
 *
 * La mise en place du validateur et la création des index sont enchaînées ici
 * plutôt que confiées à une migration manuelle : le démarrage du serveur est le
 * seul moment dont on est certain qu'il précède toute écriture, et un
 * déploiement sur une base neuve doit aboutir sans intervention. Le validateur
 * passe en premier : créer un index sur `users` crée la collection, et elle
 * naîtrait alors sans validateur. Les deux étapes sont idempotentes.
 *
 * @returns {Promise<void>} Résolue lorsque la base est connectée et prête.
 * @throws {Error} Si la connexion au serveur MongoDB échoue.
 */
async function connectMongo() {
  client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db(DB_NAME);
  logger.info(`[db] Connecté à MongoDB : ${DB_NAME}`);

  await _updateUsersValidator();
  await _ensureIndexes();
}

/**
 * Ferme la connexion et remet le module à son état initial.
 *
 * Appelée en fin de suite de tests : le pilote MongoDB maintient un pool de
 * sockets qui empêche le processus Node de se terminer, ce qui ferait expirer
 * la suite plutôt que passer. Les références sont vidées pour qu'un
 * {@link getDb} ultérieur échoue franchement au lieu d'opérer sur un client
 * fermé.
 *
 * @returns {Promise<void>} Résolue lorsque la connexion est close. Sans effet
 *   si aucune connexion n'est ouverte.
 */
async function closeMongo() {
  if (client) {
    await client.close();
    client = undefined;
    db = undefined;
  }
}

/**
 * Rend l'instance de base de données partagée.
 *
 * L'échec est immédiat et explicite lorsque la connexion n'est pas établie :
 * rendre une valeur absente laisserait l'erreur se manifester bien plus loin,
 * sous la forme d'un accès sur `undefined` dans un service, sans indiquer que
 * la cause est un démarrage incomplet.
 *
 * @returns {import("mongodb").Db} Instance connectée.
 * @throws {Error} Si {@link connectMongo} n'a pas été appelée, ou si
 *   {@link closeMongo} l'a été depuis.
 */
function getDb() {
  if (!db) throw new Error("Base de données non connectée");
  return db;
}

/**
 * Crée les index de recherche et les index TTL portant les durées de
 * conservation.
 *
 * Deux catégories cohabitent.
 *
 * Les index de recherche rendent exploitable le stockage chiffré : `emailHash`
 * est unique et creux, ce qui fait respecter l'unicité du compte sur une donnée
 * qu'aucune requête ne peut lire en clair — le caractère creux évite qu'une
 * multitude de comptes sans téléphone entrent en collision sur `null`.
 * L'unicité posée ici est la seule barrière contre le doublon de compte,
 * puisqu'aucun code applicatif ne peut comparer deux adresses chiffrées.
 *
 * Les index TTL portent les durées de conservation. Elles sont exprimées comme
 * propriété de la base et non comme tâche applicative, pour les raisons
 * exposées en tête de module. Les durées retenues :
 * - cache d'itinéraires, sept jours, sur la péremption de l'information ;
 * - comptage d'usage, vingt-quatre heures, alignée sur la fenêtre de quota ;
 * - journal d'audit, un an, au titre de l'article 5(f) du RGPD : la traçabilité
 *   des accès aux données personnelles doit couvrir un cycle complet
 *   d'exploitation pour rester utile à une investigation, sans devenir
 *   elle-même une accumulation de traces sans terme ;
 * - preuves de consentement, cinq ans, au titre de l'article 7 : la charge de
 *   prouver le consentement pèse sur le responsable de traitement, la durée est
 *   donc calée sur le délai de prescription pendant lequel cette preuve peut
 *   être exigée, et non sur la durée de vie du compte.
 *
 * Chaque groupe est isolé dans son propre `try` : l'échec d'un index ne doit
 * pas empêcher la création des suivants, un démarrage partiellement indexé
 * restant préférable à un serveur qui refuse de démarrer. Les échecs sont
 * journalisés et non propagés pour cette raison.
 *
 * @returns {Promise<void>} Résolue lorsque toutes les tentatives ont été faites.
 * @private
 */
async function _ensureIndexes() {
  try {
    await db.collection("users").createIndex({ emailHash: 1 }, { unique: true, sparse: true });
  } catch (err) {
    logger.error("[db] Erreur lors de la création de l'index users.emailHash :", err.message);
  }
  try {
    await db.collection("users").createIndex({ phoneHash: 1 }, { sparse: true });
  } catch (err) {
    logger.error("[db] Erreur lors de la création de l'index users.phoneHash :", err.message);
  }

  try {
    await db.collection("itinerary_cache").createIndex({ city: 1, days: 1 });
    await db
      .collection("itinerary_cache")
      .createIndex({ createdAt: 1 }, { expireAfterSeconds: TTL_ITINERARY_CACHE_S });
  } catch (err) {
    logger.error("[db] Erreur lors de la création des index itinerary_cache :", err.message);
  }

  try {
    await db
      .collection("itinerary_usage")
      .createIndex({ userId: 1, createdAt: 1 });
    await db
      .collection("itinerary_usage")
      .createIndex({ createdAt: 1 }, { expireAfterSeconds: TTL_ITINERARY_USAGE_S });
  } catch (err) {
    logger.error("[db] Erreur lors de la création des index itinerary_usage :", err.message);
  }

  try {
    await db.collection("users").createIndex({ calendarToken: 1 }, { sparse: true });
  } catch (err) {
    logger.error("[db] Erreur lors de la création de l'index users.calendarToken :", err.message);
  }

  // RGPD Art. 5(f) — Audit logs : TTL 1 an + index userId pour audit ciblé
  try {
    await db.collection("auditLogs").createIndex(
      { createdAt: 1 },
      { expireAfterSeconds: 365 * 24 * 60 * 60 }
    );
    await db.collection("auditLogs").createIndex({ userId: 1 });
  } catch (err) {
    logger.error("[db] Erreur lors de la création des index auditLogs :", err.message);
  }

  // Subscriptions : lookup par userId, filtrage par statut et par date de fin.
  // Aucun index TTL ici, volontairement : un abonnement est une trace de
  // transaction, qui doit survivre à sa propre expiration pour servir de preuve
  // d'achat en cas de litige et répondre aux obligations comptables. La purge
  // automatique appliquée au cache et au comptage d'usage n'a pas lieu d'être.
  try {
    await db.collection("subscriptions").createIndex({ userId: 1 }, { unique: true });
    await db.collection("subscriptions").createIndex({ status: 1 });
    await db.collection("subscriptions").createIndex({ endDate: 1 });
    // Les webhooks Stripe identifient l'abonnement par son id côté PSP
    await db.collection("subscriptions").createIndex({ stripeSubscriptionId: 1 }, { sparse: true });
  } catch (err) {
    logger.error("[db] Erreur lors de la création des index subscriptions :", err.message);
  }

  // Web Push : un endpoint = un navigateur, unicité pour l'upsert d'abonnement
  try {
    await db.collection("pushSubscriptions").createIndex({ endpoint: 1 }, { unique: true });
    await db.collection("pushSubscriptions").createIndex({ userId: 1 });
  } catch (err) {
    logger.error("[db] Erreur lors de la création des index pushSubscriptions :", err.message);
  }

  // RGPD Art. 7 — Consentements : index userId pour lookup rapide + TTL 5 ans
  try {
    await db.collection("user_consents").createIndex({ userId: 1 });
    await db.collection("user_consents").createIndex(
      { createdAt: 1 },
      { expireAfterSeconds: 5 * 365 * 24 * 60 * 60 }
    );
  } catch (err) {
    logger.error("[db] Erreur lors de la création des index user_consents :", err.message);
  }
}

/**
 * Pose le validateur `$jsonSchema` de `users`, ou l'aligne sur le schéma
 * courant s'il existe déjà.
 *
 * Trois situations sont distinguées.
 *
 * Sur une base neuve, la collection est créée avec {@link USERS_SCHEMA}, en
 * niveau `strict` et en rejet : aucun document ne peut y entrer sans respecter
 * le contrat, et le schéma vit dans le dépôt plutôt que dans une console.
 *
 * Si la collection existe sans validateur, le schéma est posé en niveau
 * `moderate` : les insertions et les documents déjà conformes sont contrôlés,
 * mais un document antérieur non conforme reste modifiable. Passer d'emblée en
 * `strict` bloquerait la mise à jour de comptes existants pour une règle qu'ils
 * n'ont jamais eu à respecter.
 *
 * Si un validateur existe, il est lu avant d'être réécrit et seules les
 * propriétés qui divergent sont corrigées : remplacer le schéma entier
 * écraserait les contraintes posées à la création de la collection. La
 * correction porte sur les champs de {@link NULLABLE_USER_FIELDS}, rendus
 * nullables ; la liste des champs requis n'est pas touchée.
 *
 * Chaque branche n'agit que sur un écart constaté, ce qui garde l'opération
 * idempotente au fil des redémarrages. Un échec est journalisé en avertissement
 * et non propagé : le validateur est une garantie supplémentaire, son
 * indisponibilité ne justifie pas de refuser le démarrage.
 *
 * @returns {Promise<void>} Résolue une fois la tentative faite.
 * @private
 */
async function _updateUsersValidator() {
  try {
    const infos = await db
      .listCollections({ name: "users" }, { nameOnly: false })
      .toArray();
    const info = infos[0];

    if (!info) {
      await db.createCollection("users", {
        validator: { $jsonSchema: USERS_SCHEMA },
        validationLevel: "strict",
        validationAction: "error",
      });
      logger.info("[db] Collection users créée avec son validateur");
      return;
    }

    const schema = info.options?.validator?.$jsonSchema;
    if (!schema) {
      await db.command({
        collMod: "users",
        validator: { $jsonSchema: USERS_SCHEMA },
        validationLevel: "moderate",
        validationAction: "error",
      });
      logger.info("[db] Validateur users posé sur la collection existante");
      return;
    }

    const divergent = NULLABLE_USER_FIELDS.filter((field) => {
      const bsonType = schema.properties?.[field]?.bsonType;
      return !(Array.isArray(bsonType) && bsonType.includes("null"));
    });
    if (schema.properties && divergent.length > 0) {
      const properties = { ...schema.properties };
      for (const field of divergent) {
        properties[field] = { bsonType: ["string", "null"] };
      }

      await db.command({
        collMod: "users",
        validator: { $jsonSchema: { ...schema, properties } },
        validationLevel: info?.options?.validationLevel || "strict",
        validationAction: info?.options?.validationAction || "error",
      });

      logger.info(`[db] Validateur users mis à jour (nullables : ${divergent.join(", ")})`);
    }
  } catch (e) {
    logger.warn("[db] Impossible de mettre à jour le validateur users :", e?.message);
  }
}

module.exports = { connectMongo, closeMongo, getDb };
