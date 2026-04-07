const { MongoClient } = require("mongodb");
const { MONGODB_URI, DB_NAME } = require("./config");

let db;

async function connectMongo() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db(DB_NAME);
  console.log(`[db] Connecté à MongoDB : ${DB_NAME}`);

  await _ensureIndexes();
  await _updateUsersValidator();
}

function getDb() {
  if (!db) throw new Error("Base de données non connectée");
  return db;
}

async function _ensureIndexes() {
  try {
    await db.collection("users").createIndex({ email: 1 }, { unique: true });
  } catch (_) {}

  try {
    await db.collection("itinerary_cache").createIndex({ city: 1, days: 1 });
    await db
      .collection("itinerary_cache")
      .createIndex({ createdAt: 1 }, { expireAfterSeconds: 604800 });
  } catch (_) {}

  try {
    await db
      .collection("itinerary_usage")
      .createIndex({ userId: 1, createdAt: 1 });
    await db
      .collection("itinerary_usage")
      .createIndex({ createdAt: 1 }, { expireAfterSeconds: 86400 });
  } catch (_) {}
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

      console.log("[db] Validateur users mis à jour (phone activé)");
    }
  } catch (e) {
    console.log("[db] Impossible de mettre à jour le validateur users :", e?.message);
  }
}

module.exports = { connectMongo, getDb };
