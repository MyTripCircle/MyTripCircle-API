const { MongoClient } = require("mongodb");
const { MONGODB_URI, DB_NAME } = require("./config");
const logger = require("./utils/logger");

const TTL_ITINERARY_CACHE_S = 604800;  // 7 jours
const TTL_ITINERARY_USAGE_S = 86400;   // 24 heures

let db;

async function connectMongo() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db(DB_NAME);
  logger.info(`[db] Connecté à MongoDB : ${DB_NAME}`);

  await _ensureIndexes();
  await _updateUsersValidator();
}

function getDb() {
  if (!db) throw new Error("Base de données non connectée");
  return db;
}

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
}

async function _updateUsersValidator() {
  try {
    const infos = await db
      .listCollections({ name: "users" }, { nameOnly: false })
      .toArray();
    const info = infos[0];
    const schema = info?.options?.validator?.$jsonSchema;

    if (schema?.properties && !schema.properties.phone) {
      const nextSchema = {
        ...schema,
        properties: {
          ...schema.properties,
          phone: { bsonType: "string" },
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

module.exports = { connectMongo, getDb };
