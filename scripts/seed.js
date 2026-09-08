#!/usr/bin/env node
/**
 * Alimente une base MongoDB avec le jeu de démonstration décrit dans
 * `scripts/seed-dataset.js`.
 *
 * Deux garde-fous encadrent l'écriture, parce qu'un script d'alimentation est
 * exactement le genre d'outil qu'on finit par lancer sur la mauvaise base.
 * D'abord l'idempotence : chaque document est écrit sous un identifiant figé,
 * si bien qu'une seconde exécution remet le jeu à son état nominal au lieu de
 * le dupliquer. Ensuite le refus : la présence du moindre document que ce
 * script n'a pas écrit interrompt l'opération, sauf confirmation explicite par
 * `--force`. La combinaison des deux fait qu'aucune donnée étrangère au jeu de
 * démonstration ne peut être écrasée par mégarde.
 *
 * Usage :
 *   npm run seed                 # alimente une base vide ou déjà alimentée
 *   node scripts/seed.js --force # passe outre la présence de données tierces
 *   node scripts/seed.js --clean # retire uniquement le jeu de démonstration
 */

require("dotenv").config();
const bcrypt = require("bcrypt");
const { connect, explainConnectionError, missingEnvVars, redactUri } = require("./mongo-cli");
const { buildDataset, DEMO_PASSWORD, demoEmailHashes } = require("./seed-dataset");

/** Coût bcrypt appliqué par le serveur à l'inscription ; repris à l'identique. */
const BCRYPT_ROUNDS = 10;

/**
 * Lit les options de la ligne de commande.
 *
 * @param {string[]} argv Arguments hors exécutable et script.
 * @returns {{ force: boolean, clean: boolean, help: boolean, unknown: string[] }}
 */
function parseArgs(argv) {
  const known = new Set(["--force", "--clean", "--help", "-h"]);
  return {
    force: argv.includes("--force"),
    clean: argv.includes("--clean"),
    help: argv.includes("--help") || argv.includes("-h"),
    unknown: argv.filter((arg) => !known.has(arg)),
  };
}

/** Identifiants figés du jeu, par collection. */
function demoIdsOf(dataset) {
  return dataset.map(({ name, documents }) => ({ name, ids: documents.map((doc) => doc._id) }));
}

/**
 * Dénombre, collection par collection, les documents que ce script n'a pas écrits.
 *
 * C'est ce comptage, et non un `countDocuments` global, qui déclenche le refus :
 * une base déjà alimentée par une exécution précédente doit rester
 * réalimentable sans confirmation, sans quoi l'idempotence promise serait
 * inutilisable.
 *
 * @param {import("mongodb").Db} db Base connectée.
 * @param {Array<{ name: string, documents: object[] }>} dataset Jeu à écrire.
 * @returns {Promise<Array<{ name: string, count: number }>>} Collections
 *   contenant des documents tiers, les autres étant omises.
 */
async function foreignDocuments(db, dataset) {
  const found = [];
  for (const { name, ids } of demoIdsOf(dataset)) {
    const count = await db.collection(name).countDocuments({ _id: { $nin: ids } });
    if (count > 0) found.push({ name, count });
  }
  return found;
}

/**
 * Repère les comptes portant une adresse de démonstration sous un autre identifiant.
 *
 * Sans ce contrôle, l'écriture échouerait sur la violation de l'index unique
 * `users.emailHash`, avec un message du pilote qui ne désignerait pas la cause.
 * Le cas se produit dès qu'un compte de démonstration a été créé autrement, par
 * exemple via `scripts/add-user.js` ou par l'inscription depuis l'application.
 *
 * @param {import("mongodb").Db} db Base connectée.
 * @param {object[]} demoUserIds Identifiants figés des comptes de démonstration.
 * @returns {Promise<object[]>} Identifiants des comptes en conflit.
 * @throws {Error} Si les clés de chiffrement ne sont pas configurées.
 */
async function conflictingAccounts(db, demoUserIds) {
  const docs = await db
    .collection("users")
    .find({ emailHash: { $in: demoEmailHashes() }, _id: { $nin: demoUserIds } })
    .project({ _id: 1 })
    .toArray();
  return docs.map((doc) => doc._id);
}

/**
 * Écrit le jeu de données.
 *
 * `replaceOne` en mode upsert plutôt qu'`insertOne` : c'est ce qui rend
 * l'opération rejouable, et ce qui garantit qu'un document de démonstration
 * modifié à la main revient à sa forme attendue.
 *
 * @param {import("mongodb").Db} db Base connectée.
 * @param {Array<{ name: string, documents: object[] }>} dataset Jeu à écrire.
 * @returns {Promise<Array<{ name: string, created: number, updated: number }>>}
 *   Bilan par collection.
 */
async function writeDataset(db, dataset) {
  const written = [];
  for (const { name, documents } of dataset) {
    let created = 0;
    let updated = 0;
    for (const doc of documents) {
      const result = await db.collection(name).replaceOne({ _id: doc._id }, doc, { upsert: true });
      if (result.upsertedCount > 0) created += 1;
      else updated += 1;
    }
    written.push({ name, created, updated });
  }
  return written;
}

/**
 * Retire le jeu de démonstration, et lui seul.
 *
 * La suppression est bornée aux identifiants figés : un `deleteMany` sans
 * filtre viderait des collections dont ce script ne connaît pas le contenu.
 *
 * @param {import("mongodb").Db} db Base connectée.
 * @param {Array<{ name: string, documents: object[] }>} dataset Jeu de référence.
 * @returns {Promise<Array<{ name: string, deleted: number }>>} Bilan par collection.
 */
async function cleanDataset(db, dataset) {
  const removed = [];
  for (const { name, ids } of demoIdsOf(dataset)) {
    const { deletedCount } = await db.collection(name).deleteMany({ _id: { $in: ids } });
    removed.push({ name, deleted: deletedCount });
  }
  return removed;
}

/**
 * Enchaîne contrôles puis écriture.
 *
 * @param {import("mongodb").Db} db Base connectée.
 * @param {Array<{ name: string, documents: object[] }>} dataset Jeu à écrire.
 * @param {{ force?: boolean }} [options]
 * @returns {Promise<{ refused?: string, written?: object[] }>} Motif de refus,
 *   ou bilan d'écriture.
 */
async function seed(db, dataset, { force = false } = {}) {
  // Le conflit d'adresse est examiné avant le comptage des documents tiers :
  // c'est le diagnostic le plus précis des deux, et un compte de démonstration
  // créé autrement serait sinon signalé comme une donnée étrangère quelconque.
  const demoUserIds = dataset.find((c) => c.name === "users").documents.map((doc) => doc._id);
  const conflicts = await conflictingAccounts(db, demoUserIds);
  if (conflicts.length > 0) {
    if (!force) {
      return {
        refused:
          `${conflicts.length} compte(s) utilisent déjà une adresse de démonstration sous un autre identifiant.\n` +
          "   L'index unique users.emailHash ferait échouer l'écriture. Relancez avec\n" +
          "   --force pour remplacer ces comptes de démonstration.",
      };
    }
    await db.collection("users").deleteMany({ _id: { $in: conflicts } });
  }

  const foreign = await foreignDocuments(db, dataset);
  if (foreign.length > 0 && !force) {
    const detail = foreign.map(({ name, count }) => `${name} (${count})`).join(", ");
    return {
      refused:
        `la base contient des documents étrangers au jeu de démonstration : ${detail}.\n` +
        "   Ciblez une base dédiée via MONGODB_URI ou DB_NAME, ou relancez avec --force\n" +
        "   si vous acceptez d'y ajouter le jeu de démonstration (aucune donnée\n" +
        "   existante n'est supprimée, seuls les documents de démonstration sont écrits).",
    };
  }

  return { written: await writeDataset(db, dataset) };
}

/** Met en forme un bilan d'écriture ou de suppression. */
function formatSummary(rows) {
  const width = Math.max(...rows.map((row) => row.name.length));
  return rows
    .map((row) => {
      const detail =
        row.deleted === undefined
          ? `${row.created} créé(s), ${row.updated} mis à jour`
          : `${row.deleted} supprimé(s)`;
      return `  ${row.name.padEnd(width)}  ${detail}`;
    })
    .join("\n");
}

/** Rappel des identifiants de connexion du jeu de démonstration. */
function formatCredentials(dataset) {
  return [
    "",
    "── Comptes de démonstration ──",
    "  alice.demo@example.com   (propriétaire des voyages, abonnement premium)",
    "  bruno.demo@example.com   (collaborateur du voyage « Week-end à Porto »)",
    "  chloe.demo@example.com   (compte sans voyage, offre gratuite)",
    `  Mot de passe commun : ${DEMO_PASSWORD}`,
    "",
    "  Adresses et numéros fictifs (domaine example.com, plage téléphonique",
    `  réservée à la fiction) — ${dataset.reduce((total, c) => total + c.documents.length, 0)} documents au total.`,
  ].join("\n");
}

/**
 * Point d'entrée : contrôle l'environnement, connecte, écrit, rend compte.
 *
 * @param {string[]} [argv] Arguments de ligne de commande.
 * @returns {Promise<number>} 0 en cas de succès, 1 sinon.
 */
async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help || options.unknown.length > 0) {
    if (options.unknown.length > 0) console.error(`❌ Option inconnue : ${options.unknown.join(", ")}`);
    console.log("Usage : node scripts/seed.js [--force] [--clean]");
    console.log("  --force  écrit même si la base contient d'autres documents");
    console.log("  --clean  retire le jeu de démonstration au lieu de l'écrire");
    return options.unknown.length > 0 ? 1 : 0;
  }

  const missingVars = missingEnvVars(process.env, true);
  if (missingVars.length > 0) {
    console.error(`❌ Variables d'environnement manquantes : ${missingVars.join(", ")}`);
    console.error("   Renseignez-les dans le fichier .env (modèle : .env.example).");
    return 1;
  }

  // Une base de production n'a pas à recevoir de données de démonstration ; le
  // refus est levé explicitement plutôt que laissé au jugement de l'opérateur.
  if (process.env.NODE_ENV === "production" && !options.force) {
    console.error("❌ NODE_ENV=production : alimentation refusée.");
    console.error("   Relancez avec --force uniquement si la cible est bien une base de démonstration.");
    return 1;
  }

  const uri = process.env.MONGODB_URI;
  let client;
  try {
    const passwordHash = await bcrypt.hash(DEMO_PASSWORD, BCRYPT_ROUNDS);
    const dataset = buildDataset({ now: new Date(), passwordHash });

    const connection = await connect();
    client = connection.client;
    console.log(`Base ciblée : ${connection.dbName} sur ${redactUri(uri)}\n`);

    if (options.clean) {
      console.log("── Suppression du jeu de démonstration ──");
      console.log(formatSummary(await cleanDataset(connection.db, dataset)));
      console.log("\n✅ Jeu de démonstration retiré.");
      return 0;
    }

    const result = await seed(connection.db, dataset, { force: options.force });
    if (result.refused) {
      console.error(`❌ Alimentation refusée : ${result.refused}`);
      return 1;
    }

    console.log("── Documents écrits ──");
    console.log(formatSummary(result.written));
    console.log(formatCredentials(dataset));
    console.log("\n✅ Base alimentée. Vérifiez l'état avec `npm run test-db`.");
    return 0;
  } catch (err) {
    console.error("❌ Alimentation impossible.");
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

module.exports = {
  parseArgs,
  foreignDocuments,
  conflictingAccounts,
  writeDataset,
  cleanDataset,
  seed,
  formatSummary,
  main,
};
