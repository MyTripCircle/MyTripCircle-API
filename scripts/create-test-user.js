#!/usr/bin/env node
/**
 * Crée, met à jour ou supprime un compte de test vérifié, destiné aux tests de
 * charge k6 sur `POST /users/login`.
 *
 * `/users/register` ne convient pas : il crée un compte non vérifié, en attente
 * d'un code à usage unique, et la connexion lui est refusée tant que ce code
 * n'a pas été saisi. Le script écrit donc directement un compte vérifié, avec
 * les mêmes utilitaires de chiffrement et le même coût bcrypt que le serveur,
 * pour que la connexion mesurée soit celle d'un utilisateur réel.
 *
 * Idempotent : relancé avec la même adresse, il réinitialise le mot de passe
 * et remet le compte à l'état vérifié, sans doublon — l'index unique sur
 * `emailHash` l'interdirait de toute façon.
 *
 * Usage :
 *   node scripts/create-test-user.js [email] [mot de passe] [nom]
 *   TEST_EMAIL=… TEST_PASSWORD=… node scripts/create-test-user.js
 *   node scripts/create-test-user.js --delete [email]
 */

require("dotenv").config();
const bcrypt = require("bcrypt");
const { connect, explainConnectionError, missingEnvVars, redactUri } = require("./mongo-cli");
const { encryptUserFields, hashField } = require("../utils/crypto");
const { isStrongPassword } = require("../utils/authHelpers");

/** Coût bcrypt appliqué par le serveur à l'inscription ; repris à l'identique. */
const BCRYPT_ROUNDS = 10;

const DEFAULTS = {
  email: "loadtest@mytripcircle.local",
  password: "LoadTest!42",
  name: "Load Test",
};

/**
 * Lit la ligne de commande, les variables `TEST_*` servant de repli.
 *
 * @param {string[]} argv Arguments hors exécutable et script.
 * @param {object} [env] Environnement, injectable pour les tests.
 * @returns {{ remove: boolean, email: string, password: string, name: string }}
 */
function parseArgs(argv, env = process.env) {
  const remove = argv[0] === "--delete";
  const [email, password, name] = remove ? argv.slice(1) : argv;
  return {
    remove,
    email: (email || env.TEST_EMAIL || DEFAULTS.email).toLowerCase(),
    password: password || env.TEST_PASSWORD || DEFAULTS.password,
    name: name || env.TEST_NAME || DEFAULTS.name,
  };
}

/**
 * Écrit le compte de test, ou le remet à l'état nominal s'il existe déjà.
 *
 * @param {import("mongodb").Db} db Base cible.
 * @param {{ email: string, name: string, passwordHash: string, now: Date }} account
 * @returns {Promise<"created" | "updated">} Opération effectuée.
 */
async function upsertTestUser(db, { email, name, passwordHash, now }) {
  const users = db.collection("users");
  const existing = await users.findOne({ emailHash: hashField(email) });
  if (existing) {
    await users.updateOne(
      { _id: existing._id },
      { $set: { password: passwordHash, verified: true, updatedAt: now } }
    );
    return "updated";
  }
  await users.insertOne(
    encryptUserFields({
      name,
      email,
      password: passwordHash,
      verified: true,
      createdAt: now,
      updatedAt: now,
    })
  );
  return "created";
}

/**
 * Supprime le compte de test désigné par son adresse.
 *
 * @param {import("mongodb").Db} db Base cible.
 * @param {string} email Adresse du compte.
 * @returns {Promise<boolean>} Vrai si un compte a été supprimé.
 */
async function deleteTestUser(db, email) {
  const { deletedCount } = await db.collection("users").deleteOne({ emailHash: hashField(email) });
  return deletedCount > 0;
}

/**
 * Point d'entrée : rend le code de sortie plutôt que d'appeler `process.exit`,
 * pour que les tests puissent l'exécuter en entier.
 *
 * @param {string[]} [argv] Arguments hors exécutable et script.
 * @returns {Promise<number>} 0 en cas de succès, 1 sinon.
 */
async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);

  const missingVars = missingEnvVars(process.env, true);
  if (missingVars.length > 0) {
    console.error(`❌ Variables d'environnement manquantes : ${missingVars.join(", ")}`);
    console.error("   Renseignez-les dans le fichier .env (modèle : .env.example).");
    return 1;
  }

  if (!options.remove && !isStrongPassword(options.password)) {
    console.error("❌ Mot de passe trop faible : 8 caractères minimum, avec minuscule, majuscule, chiffre et caractère spécial.");
    return 1;
  }

  let client;
  try {
    const connection = await connect();
    client = connection.client;
    console.log(`Base ciblée : ${connection.dbName} sur ${redactUri(process.env.MONGODB_URI)}\n`);

    if (options.remove) {
      const removed = await deleteTestUser(connection.db, options.email);
      console.log(removed ? `🗑️  Compte supprimé : ${options.email}` : `Aucun compte trouvé pour ${options.email}`);
      return 0;
    }

    const passwordHash = await bcrypt.hash(options.password, BCRYPT_ROUNDS);
    const outcome = await upsertTestUser(connection.db, {
      email: options.email,
      name: options.name,
      passwordHash,
      now: new Date(),
    });
    console.log(outcome === "created" ? "✅ Compte de test créé." : "♻️  Compte de test remis à l'état vérifié.");
    console.log("\n── Lancer le test de charge ──");
    console.log(`  k6 run -e EMAIL='${options.email}' -e PASSWORD='${options.password}' tests/load/login.load.js`);
    return 0;
  } catch (err) {
    console.error("❌ Opération impossible.");
    console.error(`   ${explainConnectionError(err)}`);
    return 1;
  } finally {
    if (client) await client.close();
  }
}

// Comparaison sur le chemin plutôt que sur le module lui-même : `require.main
// === module` porte sur deux types que l'analyse statique juge disjoints.
if (require.main?.filename === __filename) {
  main().then((code) => {
    process.exitCode = code;
  });
}

module.exports = { parseArgs, upsertTestUser, deleteTestUser, main };
