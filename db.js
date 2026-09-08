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

let db;
let client;

/**
 * Ouvre la connexion, puis met la base en conformité avec le schéma attendu.
 *
 * La création des index et la mise à jour du validateur sont enchaînées ici
 * plutôt que confiées à une migration manuelle : le démarrage du serveur est le
 * seul moment dont on est certain qu'il précède toute écriture, et un
 * déploiement sur une base neuve doit aboutir sans intervention. Les deux
 * étapes sont idempotentes.
 *
 * @returns {Promise<void>} Résolue lorsque la base est connectée et prête.
 * @throws {Error} Si la connexion au serveur MongoDB échoue.
 */
async function connectMongo() {
  client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db(DB_NAME);
  logger.info(`[db] Connecté à MongoDB : ${DB_NAME}`);

  await _ensureIndexes();
  await _updateUsersValidator();
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
 * Aligne le validateur `$jsonSchema` de `users` sur le schéma courant.
 *
 * Le validateur est lu avant d'être réécrit, et seule la propriété qui diverge
 * est corrigée : remplacer le schéma entier écraserait les contraintes posées à
 * la création de la collection, que ce module ne connaît pas. La correction
 * porte sur `phone`, devenu facultatif — un validateur qui refuse `null` fait
 * échouer l'effacement du numéro par l'utilisateur, alors que la collection
 * existante en production ne peut pas être recréée.
 *
 * L'opération est conditionnée à la divergence constatée afin de rester
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
    const schema = info?.options?.validator?.$jsonSchema;

    const phoneSchema = schema?.properties?.phone;
    const phoneAllowsNull = Array.isArray(phoneSchema?.bsonType) && phoneSchema.bsonType.includes("null");
    if (schema?.properties && (!phoneSchema || !phoneAllowsNull)) {
      const nextSchema = {
        ...schema,
        properties: {
          ...schema.properties,
          phone: { bsonType: ["string", "null"] },
        },
      };

      await db.command({
        collMod: "users",
        validator: { $jsonSchema: nextSchema },
        validationLevel: info?.options?.validationLevel || "strict",
        validationAction: info?.options?.validationAction || "error",
      });

      logger.info("[db] Validateur users mis à jour (phone activé)");
    }
  } catch (e) {
    logger.warn("[db] Impossible de mettre à jour le validateur users :", e?.message);
  }
}

module.exports = { connectMongo, closeMongo, getDb };
