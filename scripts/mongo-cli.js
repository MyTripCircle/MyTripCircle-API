/**
 * Ouverture de connexion MongoDB pour les scripts en ligne de commande.
 *
 * `server/db.js` n'est pas réutilisable ici : il crée les index et modifie le
 * validateur au moment de la connexion, ce qu'un simple test de connexion ne
 * doit surtout pas faire — il constaterait alors l'état qu'il vient lui-même
 * d'établir. Ce module se limite donc à ouvrir, et à traduire les échecs.
 *
 * Le délai de sélection de serveur est volontairement court : la valeur par
 * défaut du pilote fait attendre trente secondes avant d'admettre qu'aucun
 * serveur ne répond, durée pendant laquelle un opérateur croit à un blocage.
 *
 * @module scripts/mongo-cli
 */

const { MongoClient } = require("mongodb");

/** Délai maximal de sélection d'un serveur, en millisecondes. */
const SERVER_SELECTION_TIMEOUT_MS = 5000;

/** Variables d'environnement sans lesquelles aucun de ces scripts ne peut travailler. */
const REQUIRED_VARS = ["MONGODB_URI"];

/** Variables supplémentaires exigées dès qu'un script lit ou écrit des champs chiffrés. */
const CRYPTO_VARS = ["ENCRYPTION_KEY", "HMAC_KEY"];

/**
 * Vérifie la présence des variables d'environnement nécessaires.
 *
 * L'échec est immédiat et nomme les variables manquantes : laisser le pilote
 * échouer plus loin sur une URI indéfinie produirait un message qui ne désigne
 * pas la cause.
 *
 * @param {object} [env] Environnement à inspecter, injectable pour les tests.
 * @param {boolean} [needsCrypto] Exiger aussi les clés de chiffrement.
 * @returns {string[]} Noms des variables manquantes, vide si tout est présent.
 */
function missingEnvVars(env = process.env, needsCrypto = false) {
  const required = needsCrypto ? [...REQUIRED_VARS, ...CRYPTO_VARS] : REQUIRED_VARS;
  return required.filter((name) => !env[name]);
}

/**
 * Traduit une erreur du pilote en consigne exploitable.
 *
 * Les messages du pilote décrivent le symptôme réseau, jamais la correction à
 * apporter. Chaque cas fréquent est donc rattaché à l'action qui le résout ; le
 * message d'origine est conservé en dernier ressort plutôt que masqué.
 *
 * @param {Error} err Erreur levée par le pilote MongoDB.
 * @returns {string} Message d'une ou deux phrases, orienté action.
 */
function explainConnectionError(err) {
  const message = err?.message || "erreur inconnue";

  if (/ECONNREFUSED/.test(message)) {
    return `Aucun serveur MongoDB n'écoute à l'adresse indiquée par MONGODB_URI. Démarrez une instance locale (mongod) ou pointez MONGODB_URI vers votre cluster. (${message})`;
  }
  if (/ENOTFOUND|querySrv|getaddrinfo/i.test(message)) {
    return `Le nom d'hôte de MONGODB_URI n'a pas pu être résolu : vérifiez l'URI et la connectivité réseau. (${message})`;
  }
  if (/Authentication failed|bad auth/i.test(message)) {
    return `Identifiants refusés par le serveur : vérifiez l'utilisateur et le mot de passe de MONGODB_URI. (${message})`;
  }
  if (/not authorized|Unauthorized/i.test(message)) {
    return `Le compte utilisé n'a pas les droits nécessaires sur cette base : vérifiez son rôle. (${message})`;
  }
  if (/timed out|ServerSelection/i.test(message)) {
    return `Aucun serveur n'a répondu dans le délai imparti : instance arrêtée, pare-feu, ou adresse IP absente de la liste d'autorisation du cluster. (${message})`;
  }
  if (/Invalid scheme|Invalid connection string|must start with/i.test(message)) {
    return `MONGODB_URI est mal formée : elle doit commencer par mongodb:// ou mongodb+srv://. (${message})`;
  }
  return message;
}

/**
 * Ouvre une connexion et rend le client et la base.
 *
 * @param {object} [options]
 * @param {string} [options.uri] URI de connexion ; par défaut `MONGODB_URI`.
 * @param {string} [options.dbName] Nom de base ; par défaut `DB_NAME`, sinon
 *   `mytripcircle`.
 * @returns {Promise<{ client: import("mongodb").MongoClient, db: import("mongodb").Db, dbName: string }>}
 * @throws {Error} Si la connexion échoue ; l'appelant est chargé de traduire
 *   l'erreur via {@link explainConnectionError}.
 */
async function connect({ uri = process.env.MONGODB_URI, dbName } = {}) {
  const name = dbName || process.env.DB_NAME || "mytripcircle";
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS,
  });
  await client.connect();
  return { client, db: client.db(name), dbName: name };
}

/**
 * Masque les identifiants d'une URI avant affichage.
 *
 * Une URI de connexion porte un mot de passe : la journaliser telle quelle le
 * ferait apparaître dans les traces de la console et de la CI, ce que la
 * politique de sécurité du projet interdit. Seuls le schéma et l'hôte sont
 * conservés, ce qui suffit à diagnostiquer une erreur de cible.
 *
 * @param {string} uri URI de connexion.
 * @returns {string} URI sans identifiants, ou une mention explicite si l'entrée
 *   est absente ou illisible.
 */
function redactUri(uri) {
  if (!uri) return "(non définie)";
  const match = /^(mongodb(?:\+srv)?:\/\/)(?:[^@/]*@)?([^/?]+)/.exec(uri);
  if (!match) return "(URI illisible)";
  return `${match[1]}${match[2]}`;
}

module.exports = {
  SERVER_SELECTION_TIMEOUT_MS,
  REQUIRED_VARS,
  CRYPTO_VARS,
  missingEnvVars,
  explainConnectionError,
  connect,
  redactUri,
};
