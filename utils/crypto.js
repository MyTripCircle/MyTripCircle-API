/**
 * Couche de protection des données personnelles au repos (RGPD art. 32).
 *
 * Ce module est le seul point du serveur qui manipule les clés et les
 * primitives cryptographiques. Les appelants — services, routes, middlewares —
 * travaillent toujours sur des valeurs en clair et délèguent ici la mise en
 * forme persistée : une donnée personnelle qui ne passe pas par ce module
 * finirait en clair dans MongoDB sans que rien ne le signale. Déplacer le
 * chiffrement chez les appelants réintroduirait ce risque à chaque nouveau
 * point d'écriture, d'où la centralisation.
 *
 * Deux primitives coexistent parce qu'elles répondent à deux besoins
 * incompatibles :
 * - le chiffrement AES-256-GCM à vecteur d'initialisation aléatoire, qui
 *   protège la confidentialité et permet la restitution en clair, mais produit
 *   un cryptogramme différent à chaque appel pour une même entrée ;
 * - l'empreinte HMAC-SHA256, déterministe, qui rend la recherche par égalité
 *   possible sans déchiffrer quoi que ce soit.
 *
 * @module utils/crypto
 */

const crypto = require("node:crypto");

const ALGO = "aes-256-gcm";

/**
 * Résout les clés de chiffrement et d'empreinte depuis l'environnement.
 *
 * La résolution est faite à chaque appel plutôt qu'au chargement du module :
 * cela évite de figer des clés absentes au moment du `require` et garantit que
 * l'absence de configuration se manifeste par une erreur explicite au premier
 * usage, jamais par une écriture en clair silencieuse.
 *
 * @returns {{ encKey: Buffer, hmacKey: string }} Clé AES décodée depuis
 *   l'hexadécimal et clé HMAC brute.
 * @throws {Error} Si `ENCRYPTION_KEY` ou `HMAC_KEY` est absente de
 *   l'environnement.
 */
function getKeys() {
  const encKeyHex = process.env.ENCRYPTION_KEY;
  const hmacKey = process.env.HMAC_KEY;
  if (!encKeyHex || !hmacKey) {
    throw new Error("[crypto] ENCRYPTION_KEY et HMAC_KEY sont requis");
  }
  return { encKey: Buffer.from(encKeyHex, "hex"), hmacKey };
}

/**
 * Chiffre une valeur en AES-256-GCM avec un vecteur d'initialisation aléatoire.
 *
 * Le vecteur est tiré au sort à chaque appel, si bien que deux chiffrements de
 * la même entrée ne se ressemblent pas : un observateur de la base ne peut pas
 * déduire que deux enregistrements partagent la même valeur. C'est la contre-
 * partie de ce choix qui impose l'existence de {@link hashField} pour la
 * recherche. Le mode GCM est retenu pour son étiquette d'authentification, qui
 * fait échouer le déchiffrement d'un cryptogramme altéré au lieu de rendre des
 * octets arbitraires.
 *
 * Le vecteur et l'étiquette ne sont pas secrets : ils sont concaténés au
 * cryptogramme dans le format `iv:tag:données`, ce qui évite d'avoir à gérer
 * trois colonnes par champ protégé.
 *
 * @param {string} plaintext Valeur en clair. Les valeurs vides ou nulles sont
 *   rendues telles quelles, un champ absent n'ayant rien à protéger.
 * @returns {string} Cryptogramme hexadécimal au format `iv:tag:données`.
 * @throws {Error} Si les clés ne sont pas configurées.
 */
function encrypt(plaintext) {
  if (!plaintext) return plaintext;
  const { encKey } = getKeys();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, encKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

/**
 * Restitue une valeur chiffrée par {@link encrypt}.
 *
 * Une entrée qui ne présente pas les trois segments du format attendu est
 * rendue inchangée. Cette tolérance couvre les documents écrits avant
 * l'introduction du chiffrement : sans elle, la migration aurait exigé un arrêt
 * de service pour réécrire l'ensemble de la base. Elle ne doit pas être retirée
 * tant que des documents antérieurs subsistent.
 *
 * @param {string} ciphertext Cryptogramme au format `iv:tag:données`, ou valeur
 *   héritée en clair.
 * @returns {string} Valeur en clair.
 * @throws {Error} Si l'étiquette d'authentification ne correspond pas au
 *   cryptogramme, ce qui signale une donnée altérée ou une clé erronée.
 */
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

/**
 * Calcule l'empreinte déterministe servant à retrouver un document sans le
 * déchiffrer.
 *
 * Un champ chiffré à vecteur aléatoire n'est pas indexable par égalité : la
 * même adresse électronique produit un cryptogramme différent à chaque
 * écriture, donc aucune requête `findOne({ email })` ne peut aboutir. La
 * réponse retenue est de stocker la donnée sous deux formes — le cryptogramme
 * pour la restitution, cette empreinte pour la recherche — et de poser l'index
 * unique sur l'empreinte.
 *
 * Un HMAC est employé plutôt qu'un SHA-256 nu parce que l'espace des adresses
 * électroniques et des numéros de téléphone est énumérable : sans clé secrète,
 * une empreinte volée se retrouverait par simple parcours de dictionnaire. La
 * mise en minuscules garantit que deux saisies typographiquement différentes de
 * la même adresse convergent vers la même empreinte, sans quoi l'unicité du
 * compte serait contournable.
 *
 * @param {string} value Valeur en clair à indexer.
 * @returns {string|null} Empreinte hexadécimale, ou `null` si la valeur est
 *   absente — un `null` restant hors de l'index unique creux.
 * @throws {Error} Si les clés ne sont pas configurées.
 */
function hashField(value) {
  if (!value) return null;
  const { hmacKey } = getKeys();
  return crypto.createHmac("sha256", hmacKey).update(value.toLowerCase()).digest("hex");
}

/**
 * Prépare un document utilisateur pour la persistance en protégeant ses champs
 * identifiants.
 *
 * C'est le point de passage obligé avant tout `insertOne` ou `updateOne` sur la
 * collection `users`. Les champs recherchables — adresse électronique et
 * téléphone — sont écrits deux fois : la forme chiffrée sous le nom d'origine,
 * l'empreinte sous `emailHash` et `phoneHash`. Le nom, jamais interrogé par
 * égalité, n'a pas d'empreinte associée.
 *
 * Un champ passé à une valeur vide est explicitement remis à `null` plutôt
 * qu'omis, afin que l'empreinte périmée ne survive pas à l'effacement de la
 * donnée qu'elle indexait.
 *
 * @param {object} data Document utilisateur avec `name`, `email` et `phone` en
 *   clair, les trois étant facultatifs.
 * @returns {object} Copie du document, champs sensibles chiffrés et empreintes
 *   ajoutées. L'entrée n'est pas modifiée.
 * @throws {Error} Si les clés ne sont pas configurées.
 */
function encryptUserFields(data) {
  const result = { ...data };
  // RGPD Art. 32 — Le nom est une donnée personnelle directement identifiante
  if (result.name != null) {
    result.name = encrypt(result.name);
  }
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

/**
 * Restitue les champs identifiants d'un document utilisateur lu en base.
 *
 * Symétrique de {@link encryptUserFields}. Les empreintes sont laissées en
 * place : elles n'ont pas d'équivalent en clair et ne doivent jamais quitter le
 * serveur, ce dont la couche de sérialisation des réponses reste responsable.
 *
 * @param {object|null} doc Document brut issu de MongoDB.
 * @returns {object|null} Copie du document avec `name`, `email` et `phone` en
 *   clair, ou l'entrée telle quelle si elle est absente.
 * @throws {Error} Si les clés ne sont pas configurées.
 */
function decryptUserFields(doc) {
  if (!doc) return doc;
  return {
    ...doc,
    name: doc.name ? decrypt(doc.name) : doc.name,
    email: doc.email ? decrypt(doc.email) : doc.email,
    phone: doc.phone ? decrypt(doc.phone) : doc.phone,
  };
}

// Champs d'adresse sensibles à chiffrer (RGPD — localisation et données personnelles)
const ADDRESS_SENSITIVE_FIELDS = ["name", "address"];

/**
 * Prépare un document d'adresse pour la persistance.
 *
 * Contrairement aux utilisateurs, aucune empreinte n'est produite : les
 * adresses sont toujours atteintes par leur identifiant technique ou par leur
 * rattachement à un voyage, jamais par égalité sur leur libellé. La contrainte
 * qui impose la double écriture chez l'utilisateur ne s'applique donc pas ici.
 *
 * @param {object} data Document d'adresse avec `name` et `address` en clair.
 * @returns {object} Copie du document, champs sensibles chiffrés. L'entrée
 *   n'est pas modifiée.
 * @throws {Error} Si les clés ne sont pas configurées.
 */
function encryptAddressFields(data) {
  const result = { ...data };
  for (const field of ADDRESS_SENSITIVE_FIELDS) {
    if (result[field] != null) {
      result[field] = encrypt(result[field]);
    }
  }
  return result;
}

/**
 * Restitue les champs sensibles d'un document d'adresse lu en base.
 *
 * Symétrique de {@link encryptAddressFields}. À appliquer sur tout document
 * d'adresse avant restitution, y compris ceux lus via une agrégation.
 *
 * @param {object|null} doc Document brut issu de MongoDB.
 * @returns {object|null} Copie du document avec `name` et `address` en clair,
 *   ou l'entrée telle quelle si elle est absente.
 * @throws {Error} Si les clés ne sont pas configurées.
 */
function decryptAddressFields(doc) {
  if (!doc) return doc;
  const result = { ...doc };
  for (const field of ADDRESS_SENSITIVE_FIELDS) {
    if (result[field]) {
      result[field] = decrypt(result[field]);
    }
  }
  return result;
}

module.exports = {
  encrypt,
  decrypt,
  hashField,
  encryptUserFields,
  decryptUserFields,
  encryptAddressFields,
  decryptAddressFields,
};
