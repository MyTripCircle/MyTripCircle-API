const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const crypto = require("node:crypto");
const { JWT_SECRET, REFRESH_SECRET } = require("../config");
const { decrypt } = require("./crypto");

/**
 * Durée de validité d'un code à usage unique.
 *
 * Dix minutes : au-delà, un code intercepté dans une boîte de réception reste
 * exploitable trop longtemps ; en deçà, l'acheminement d'un courriel devient un
 * facteur d'échec plus fréquent que la sécurité gagnée.
 */
const OTP_EXPIRY_MS = 10 * 60 * 1000;

/**
 * Retire les espaces de bordure d'une valeur susceptible de ne pas être une
 * chaîne.
 *
 * Les entrées HTTP arrivent sans type garanti ; appeler `trim` directement sur
 * un corps de requête arbitraire ferait échouer le traitement sur une erreur de
 * type au lieu de laisser la validation métier produire son message. La valeur
 * non textuelle est donc rendue intacte, à charge du validateur de la rejeter.
 *
 * @param {*} v Valeur issue d'une requête.
 * @returns {*} La chaîne sans espaces de bordure, ou la valeur inchangée.
 */
function trimIfString(v) {
  return typeof v === "string" ? v.trim() : v;
}

/**
 * Vérifie qu'un mot de passe satisfait la politique de robustesse.
 *
 * Quatre classes de caractères et huit caractères au minimum. Le contrôle est
 * fait côté serveur et non seulement dans l'application : la validation côté
 * client relève de l'ergonomie, un appel direct à l'API la contournant sans
 * difficulté.
 *
 * Les groupes de l'expression rationnelle sont des assertions de préexamen sans
 * quantificateur imbriqué, forme qui ne présente pas de risque de retour sur
 * trace exponentiel sur une entrée hostile.
 *
 * @param {*} password Mot de passe candidat, de type non garanti.
 * @returns {boolean} Vrai si la politique est respectée. Faux pour toute valeur
 *   non textuelle.
 */
function isStrongPassword(password) {
  if (typeof password !== "string") return false;
  return /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/.test(password);
}

/**
 * Projette un document utilisateur vers la représentation exposée au client.
 *
 * La projection est une liste blanche construite champ par champ, jamais une
 * copie du document privée de quelques propriétés. La différence est
 * déterminante : avec une liste noire, tout champ ajouté plus tard à la
 * collection — empreinte de recherche, condensat de mot de passe, code à usage
 * unique en cours, date de suppression programmée — serait exposé par défaut
 * jusqu'à ce que quelqu'un pense à l'exclure. Ici, un champ nouveau reste
 * invisible tant qu'il n'est pas ajouté volontairement.
 *
 * Le déchiffrement est fait à cet endroit parce que c'est la frontière de
 * sortie : les appelants transmettent le résultat sans avoir à savoir que la
 * base contient autre chose.
 *
 * @param {object|null} doc Document brut issu de la collection `users`.
 * @returns {object|null} Représentation publique, ou `null` si le document est
 *   absent.
 * @throws {Error} Si les clés de chiffrement ne sont pas configurées.
 */
function sanitizeUser(doc) {
  if (!doc) return null;
  return {
    id: String(doc._id),
    name: doc.name ? decrypt(doc.name) : doc.name,
    email: doc.email ? decrypt(doc.email) : doc.email,
    phone: doc.phone ? decrypt(doc.phone) : doc.phone,
    avatar: doc.avatar,
    verified: doc.verified || false,
    createdAt: doc.createdAt,
    language: doc.language || "fr",
    isPublicProfile: doc.isPublicProfile === true,
  };
}

/**
 * Émet un jeton d'accès de courte durée.
 *
 * Quinze minutes. Un jeton d'accès n'est pas révocable une fois émis ; sa durée
 * de vie est donc la fenêtre pendant laquelle un jeton dérobé reste
 * exploitable, et c'est ce qui la fixe. Le confort de session est reporté sur le
 * jeton de rafraîchissement, lui révocable puisque stocké en base.
 *
 * Le jeton ne porte que l'identifiant : y placer des droits ou un profil
 * figerait un état que le porteur ne peut plus contredire, alors que
 * `requireAuth` relit l'utilisateur à chaque requête.
 *
 * @param {string|import("mongodb").ObjectId} userId Identifiant de
 *   l'utilisateur authentifié.
 * @returns {string} Jeton signé, valable quinze minutes.
 */
function signAccessToken(userId) {
  return jwt.sign({ id: String(userId) }, JWT_SECRET, { expiresIn: "15m" });
}

/**
 * Calcule le condensat sous lequel un jeton de rafraîchissement est stocké.
 *
 * Le jeton en clair n'est jamais persisté : une base compromise ne livre alors
 * que des condensats, inutilisables pour se faire passer pour un utilisateur.
 * La vérification consiste à condenser le jeton présenté et à comparer, ce qui
 * n'exige pas de conserver l'original.
 *
 * Un SHA-256 nu suffit ici, là où un mot de passe imposerait bcrypt : le jeton
 * est une valeur aléatoire de forte entropie produite par le serveur, hors de
 * portée d'une attaque par dictionnaire que le facteur de coût de bcrypt sert à
 * ralentir.
 *
 * @param {string} token Jeton de rafraîchissement en clair.
 * @returns {string} Condensat hexadécimal.
 */
function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * Émet un jeton de rafraîchissement et enregistre sa trace révocable.
 *
 * L'échéance est inscrite deux fois, dans le jeton et dans le document. La
 * redondance est voulue : l'échéance du jeton fait échoir la signature, celle
 * du document permet à la purge de retirer les traces devenues inutiles sans
 * avoir à vérifier chaque signature. La déconnexion ou la révocation se fait en
 * supprimant le document, opération qu'un jeton auto-porteur ne permettrait
 * pas.
 *
 * @param {import("mongodb").Db} db Base de données ; passée en paramètre pour
 *   que la fonction reste testable sans connexion établie.
 * @param {string|import("mongodb").ObjectId} userId Identifiant du titulaire.
 * @returns {Promise<string>} Jeton en clair, à transmettre au client une fois
 *   seulement — la base n'en conserve que le condensat.
 * @throws {Error} Si l'insertion en base échoue.
 */
async function createRefreshToken(db, userId) {
  const token = jwt.sign({ id: String(userId) }, REFRESH_SECRET, { expiresIn: "7d" });
  await db.collection("refreshTokens").insertOne({
    token: hashToken(token),
    userId: String(userId),
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  });
  return token;
}

/**
 * Tire un code de vérification à six chiffres.
 *
 * `crypto.randomInt` est employé plutôt que `Math.random` : ce dernier repose
 * sur un générateur non cryptographique, dont la suite est prédictible à partir
 * de quelques sorties observées. Un code de vérification devinable annulerait
 * la vérification qu'il porte.
 *
 * La borne basse écarte les valeurs à moins de six chiffres, qui trahiraient la
 * plage réellement tirée et réduiraient d'autant l'espace à parcourir.
 *
 * @returns {string} Code décimal de six chiffres.
 */
function generateOtp() {
  return crypto.randomInt(100000, 1000000).toString();
}

module.exports = {
  OTP_EXPIRY_MS,
  trimIfString,
  isStrongPassword,
  sanitizeUser,
  signAccessToken,
  createRefreshToken,
  hashToken,
  generateOtp,
};
