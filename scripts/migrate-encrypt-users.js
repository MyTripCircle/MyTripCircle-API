/**
 * Migration : chiffrement des champs PII (email, phone) dans MongoDB
 *
 * À exécuter UNE SEULE FOIS après avoir ajouté ENCRYPTION_KEY et HMAC_KEY dans .env.
 *
 * Usage : node server/scripts/migrate-encrypt-users.js
 *
 * Le script est idempotent : les documents déjà chiffrés (emailHash présent) sont ignorés.
 */

require("dotenv").config();

const REQUIRED = ["MONGODB_URI", "ENCRYPTION_KEY", "HMAC_KEY"];
const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`Variables manquantes : ${missing.join(", ")}`);
  console.error("\nPasse-les en ligne de commande :");
  console.error(`  MONGODB_URI="mongodb+srv://..." node server/scripts/migrate-encrypt-users.js`);
  process.exit(1);
}

const { MongoClient } = require("mongodb");
const crypto = require("node:crypto");

const ALGO = "aes-256-gcm";

function getKeys() {
  const encKeyHex = process.env.ENCRYPTION_KEY;
  const hmacKey = process.env.HMAC_KEY;
  if (!encKeyHex || !hmacKey) {
    throw new Error("ENCRYPTION_KEY et HMAC_KEY requis dans .env");
  }
  return { encKey: Buffer.from(encKeyHex, "hex"), hmacKey };
}

function encrypt(plaintext) {
  if (!plaintext) return plaintext;
  const { encKey } = getKeys();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, encKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

function hashField(value) {
  if (!value) return null;
  const { hmacKey } = getKeys();
  return crypto.createHmac("sha256", hmacKey).update(value.toLowerCase()).digest("hex");
}

function isEncrypted(value) {
  if (!value) return false;
  return value.split(":").length === 3;
}

function getEmailHashKey(collectionName, emailField) {
  if (collectionName === "users") return "emailHash";
  if (emailField === "inviteeEmail") return "inviteeEmailHash";
  if (emailField === "recipientEmail") return "recipientEmailHash";
  return null;
}

function getPhoneHashKey(collectionName, phoneField) {
  if (collectionName === "users") return "phoneHash";
  if (phoneField === "inviteePhone") return "inviteePhoneHash";
  if (phoneField === "recipientPhone") return "recipientPhoneHash";
  return null;
}

function buildDocumentUpdates(doc, collectionName, emailField, phoneField) {
  const updates = {};
  const email = doc[emailField];
  const phone = phoneField ? doc[phoneField] : null;

  if (email && !isEncrypted(email)) {
    updates[emailField] = encrypt(email);
    const hashKey = getEmailHashKey(collectionName, emailField);
    if (hashKey) updates[hashKey] = hashField(email);
  }

  if (phone && !isEncrypted(phone)) {
    updates[phoneField] = encrypt(phone);
    const hashKey = getPhoneHashKey(collectionName, phoneField);
    if (hashKey) updates[hashKey] = hashField(phone);
  }

  return updates;
}

async function migrateCollection(db, collectionName, emailField, phoneField) {
  const col = db.collection(collectionName);
  const cursor = col.find({});
  let migrated = 0;
  let skipped = 0;

  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    const updates = buildDocumentUpdates(doc, collectionName, emailField, phoneField);

    if (Object.keys(updates).length > 0) {
      await col.updateOne({ _id: doc._id }, { $set: updates }, { bypassDocumentValidation: true });
      migrated++;
    } else {
      skipped++;
    }
  }

  console.log(`[${collectionName}] ${migrated} migré(s), ${skipped} ignoré(s)`);
}

async function cleanup(db) {
  // Supprime les champs parasites créés par une version bugguée du script
  const spuriousFields = ["emailemailHash", "inviteeemailHash", "recipientemailHash"];
  for (const field of spuriousFields) {
    for (const col of ["users", "friends", "friendRequests", "invitations"]) {
      const result = await db.collection(col).updateMany(
        { [field]: { $exists: true } },
        { $unset: { [field]: "" } },
        { bypassDocumentValidation: true }
      );
      if (result.modifiedCount > 0) {
        console.log(`[cleanup] ${col}: suppression du champ "${field}" sur ${result.modifiedCount} document(s)`);
      }
    }
  }
}

async function run() {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db(process.env.DB_NAME || "mytripcircle");

  console.log("Démarrage de la migration...\n");

  await migrateCollection(db, "users", "email", "phone");
  await migrateCollection(db, "friends", "email", "phone");
  await migrateCollection(db, "friendRequests", "recipientEmail", "recipientPhone");
  await migrateCollection(db, "invitations", "inviteeEmail", "inviteePhone");

  console.log("\nNettoyage des champs parasites...");
  await cleanup(db);

  console.log("\nMigration terminée.");
  await client.close();
}

run().catch((e) => {
  console.error("Erreur de migration :", e.message);
  process.exit(1);
});
