#!/usr/bin/env node
/**
 * Vérifie qu'une base MongoDB est joignable et conforme à ce que le serveur
 * attend d'elle.
 *
 * Trois constats sont produits, du plus élémentaire au plus structurant : le
 * serveur répond, les collections sont dénombrées, les index critiques sont
 * présents. L'ordre importe — un échec de ping rend les deux suivants sans
 * objet, le script s'arrête donc au premier obstacle plutôt que d'empiler des
 * erreurs dérivées.
 *
 * Le code de sortie vaut 0 lorsque tout est vérifié, 1 sinon : la commande est
 * ainsi utilisable telle quelle comme étape bloquante d'un script de
 * déploiement ou d'une chaîne d'intégration.
 *
 * Usage :
 *   npm run test-db
 *   node scripts/test-connection.js
 */

require("dotenv").config();
const { connect, explainConnectionError, missingEnvVars, redactUri } = require("./mongo-cli");

/**
 * Index dont l'absence a une conséquence fonctionnelle, et non seulement un
 * coût en performance.
 *
 * La sélection est délibérément courte. `users.emailHash` porte l'unicité du
 * compte : aucun code applicatif ne peut comparer deux adresses chiffrées, cet
 * index est la seule barrière contre le doublon. Les index TTL portent les
 * durées de conservation ; leur absence n'empêche rien de fonctionner mais fait
 * silencieusement conserver des données au-delà du terme annoncé, ce qu'un
 * contrôle ne pardonne pas. Les index de simple accélération n'y figurent pas.
 */
const CRITICAL_INDEXES = [
  { collection: "users", key: { emailHash: 1 }, role: "unicité du compte (donnée chiffrée)" },
  { collection: "users", key: { phoneHash: 1 }, role: "recherche par téléphone" },
  { collection: "subscriptions", key: { userId: 1 }, role: "abonnement unique par compte" },
  { collection: "itinerary_cache", key: { createdAt: 1 }, role: "conservation 7 jours (TTL)" },
  { collection: "itinerary_usage", key: { createdAt: 1 }, role: "conservation 24 heures (TTL)" },
  { collection: "auditLogs", key: { createdAt: 1 }, role: "conservation 1 an — RGPD art. 5(f)" },
  { collection: "user_consents", key: { createdAt: 1 }, role: "conservation 5 ans — RGPD art. 7" },
];

/** Deux clés d'index sont équivalentes si elles portent les mêmes champs dans le même ordre. */
function sameKey(a, b) {
  const entriesA = Object.entries(a);
  const entriesB = Object.entries(b);
  if (entriesA.length !== entriesB.length) return false;
  return entriesA.every(([field, order], i) => entriesB[i][0] === field && entriesB[i][1] === order);
}

/**
 * Confronte les index attendus à ceux réellement déclarés.
 *
 * La comparaison porte sur la clé et non sur le nom : un index créé à la main
 * peut porter un nom quelconque tout en remplissant la même fonction, et le
 * rejeter sur ce motif signalerait un problème inexistant.
 *
 * @param {Record<string, Array<{ key: object }>>} indexesByCollection Index
 *   déclarés, par collection. Une collection absente est traitée comme
 *   dépourvue d'index.
 * @returns {Array<{ collection: string, key: object, role: string }>} Index
 *   attendus et introuvables.
 */
function findMissingIndexes(indexesByCollection) {
  return CRITICAL_INDEXES.filter((expected) => {
    const declared = indexesByCollection[expected.collection] || [];
    return !declared.some((index) => sameKey(index.key, expected.key));
  });
}

/** Rend une clé d'index sous la forme lisible `collection.champ`. */
function formatIndex({ collection, key }) {
  return `${collection}.${Object.keys(key).join("+")}`;
}

/**
 * Interroge la base et rassemble les constats.
 *
 * @param {import("mongodb").Db} db Base connectée.
 * @returns {Promise<{ pingMs: number, collections: Array<{ name: string, count: number }>, missingIndexes: object[] }>}
 * @throws {Error} Si une commande échoue ; l'appelant décide du message.
 */
async function inspect(db) {
  const startedAt = Date.now();
  await db.command({ ping: 1 });
  const pingMs = Date.now() - startedAt;

  const names = (await db.listCollections({}, { nameOnly: true }).toArray())
    .map((info) => info.name)
    .sort((a, b) => a.localeCompare(b));

  const collections = [];
  const indexesByCollection = {};
  for (const name of names) {
    collections.push({ name, count: await db.collection(name).countDocuments() });
    indexesByCollection[name] = await db.collection(name).indexes();
  }

  return { pingMs, collections, missingIndexes: findMissingIndexes(indexesByCollection) };
}

/**
 * Met en forme le compte rendu destiné à la console.
 *
 * Aucune valeur de document n'est affichée, seulement des dénombrements : ces
 * collections contiennent des données personnelles, et la sortie d'un script de
 * diagnostic finit dans des journaux de CI que personne ne relit avant de les
 * conserver.
 *
 * @param {object} report Résultat de {@link inspect}.
 * @param {string} dbName Nom de la base inspectée.
 * @param {string} uri URI de connexion, affichée sans identifiants.
 * @returns {string} Compte rendu multi-lignes.
 */
function formatReport(report, dbName, uri) {
  const lines = [
    "── Connexion ──",
    `  Serveur : ${redactUri(uri)}`,
    `  Base    : ${dbName}`,
    `  Ping    : OK (${report.pingMs} ms)`,
    "",
    `── Collections (${report.collections.length}) ──`,
  ];

  if (report.collections.length === 0) {
    lines.push("  (aucune — base vierge)");
  } else {
    const width = Math.max(...report.collections.map((c) => c.name.length));
    for (const { name, count } of report.collections) {
      lines.push(`  ${name.padEnd(width)}  ${String(count).padStart(6)} document(s)`);
    }
  }

  lines.push("", "── Index critiques ──");
  if (report.missingIndexes.length === 0) {
    lines.push(`  ✅ ${CRITICAL_INDEXES.length} index attendus, tous présents`);
  } else {
    for (const missing of report.missingIndexes) {
      lines.push(`  ❌ ${formatIndex(missing)} — manquant (${missing.role})`);
    }
    lines.push(
      "",
      "  Ces index sont créés au démarrage du serveur : lancez `npm run server` une",
      "  fois sur cette base, puis relancez `npm run test-db`."
    );
  }

  return lines.join("\n");
}

/**
 * Point d'entrée : connecte, inspecte, rend compte, et fixe le code de sortie.
 *
 * @returns {Promise<number>} 0 si la base est joignable et conforme, 1 sinon.
 */
async function main() {
  const missingVars = missingEnvVars();
  if (missingVars.length > 0) {
    console.error(`❌ Variables d'environnement manquantes : ${missingVars.join(", ")}`);
    console.error("   Renseignez-les dans le fichier .env (modèle : .env.example).");
    return 1;
  }

  const uri = process.env.MONGODB_URI;
  let client;
  try {
    const connection = await connect();
    client = connection.client;
    const report = await inspect(connection.db);
    console.log(formatReport(report, connection.dbName, uri));

    if (report.missingIndexes.length > 0) {
      console.error("\n❌ Base joignable, mais des index critiques sont absents.");
      return 1;
    }
    console.log("\n✅ Base joignable et conforme.");
    return 0;
  } catch (err) {
    console.error(`❌ Connexion à MongoDB impossible (${redactUri(uri)})`);
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

module.exports = { CRITICAL_INDEXES, sameKey, findMissingIndexes, inspect, formatReport, main };
