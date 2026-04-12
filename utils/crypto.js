const crypto = require("node:crypto");

const ALGO = "aes-256-gcm";

function getKeys() {
  const encKeyHex = process.env.ENCRYPTION_KEY;
  const hmacKey = process.env.HMAC_KEY;
  if (!encKeyHex || !hmacKey) {
    throw new Error("[crypto] ENCRYPTION_KEY et HMAC_KEY sont requis");
  }
  return { encKey: Buffer.from(encKeyHex, "hex"), hmacKey };
}

// Chiffrement AES-256-GCM avec IV aléatoire
function encrypt(plaintext) {
  if (!plaintext) return plaintext;
  const { encKey } = getKeys();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, encKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

// Déchiffrement — retourne la valeur telle quelle si elle n'est pas chiffrée (rétrocompatibilité)
function decrypt(ciphertext) {
  if (!ciphertext) return ciphertext;
  const parts = ciphertext.split(":");
  if (parts.length !== 3) return ciphertext;
  const { encKey } = getKeys();
  const [ivHex, tagHex, encHex] = parts;
  const decipher = crypto.createDecipheriv(ALGO, encKey, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return decipher.update(Buffer.from(encHex, "hex")).toString("utf8") + decipher.final("utf8");
}

// Hash HMAC-SHA256 déterministe pour les requêtes MongoDB (recherche par email/phone)
function hashField(value) {
  if (!value) return null;
  const { hmacKey } = getKeys();
  return crypto.createHmac("sha256", hmacKey).update(value.toLowerCase()).digest("hex");
}

// Chiffre email/phone d'un objet avant insertOne/updateOne, ajoute les hashes
function encryptUserFields(data) {
  const result = { ...data };
  if (result.email != null) {
    result.emailHash = hashField(result.email);
    result.email = encrypt(result.email);
  }
  if (result.phone != null) {
    result.phoneHash = result.phone ? hashField(result.phone) : null;
    result.phone = result.phone ? encrypt(result.phone) : null;
  }
  return result;
}

// Déchiffre email/phone d'un document brut issu de MongoDB
function decryptUserFields(doc) {
  if (!doc) return doc;
  return {
    ...doc,
    email: doc.email ? decrypt(doc.email) : doc.email,
    phone: doc.phone ? decrypt(doc.phone) : doc.phone,
  };
}

module.exports = { encrypt, decrypt, hashField, encryptUserFields, decryptUserFields };
