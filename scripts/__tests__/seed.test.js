// Clés factices, fixées avant tout appel aux utilitaires de chiffrement : le
// jeu de données est chiffré avec les mêmes fonctions que le serveur.
process.env.ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.HMAC_KEY =
  "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient, ObjectId } = require("mongodb");

const { buildDataset, DEMO_IDS, DEMO_USERS } = require("../seed-dataset");
const { seed, cleanDataset, foreignDocuments, parseArgs, formatSummary, main } = require("../seed");

/** Instant de référence figé : le contenu produit doit être reproductible. */
const NOW = new Date("2026-01-15T10:00:00.000Z");
const PASSWORD_HASH = "$2b$10$empreinte.factice.pour.les.tests";

let mongod;
let client;
let db;
let dataset;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db("seed-test");
}, 60000);

beforeEach(async () => {
  await db.dropDatabase();
  dataset = buildDataset({ now: NOW, passwordHash: PASSWORD_HASH });
});

afterAll(async () => {
  if (client) await client.close();
  if (mongod) await mongod.stop();
});

/** Documents d'une collection du jeu, par nom. */
function documentsOf(name) {
  return dataset.find((collection) => collection.name === name).documents;
}

describe("buildDataset — confidentialité", () => {
  it("should use documentation-only domains when accounts are built", () => {
    const emails = DEMO_USERS.map((user) => user.email);

    expect(emails).toHaveLength(3);
    expect(emails.every((email) => email.endsWith("@example.com"))).toBe(true);
  });

  it("should keep phone numbers inside the fiction-reserved range when accounts carry one", () => {
    const phones = DEMO_USERS.map((user) => user.phone).filter(Boolean);

    expect(phones.every((phone) => /^\+3363998\d{4}$/.test(phone))).toBe(true);
  });

  it("should encrypt identifying fields when users are built", () => {
    const [alice] = documentsOf("users");

    expect(alice.name).not.toBe("Alice Démo");
    expect(alice.email).not.toBe("alice.demo@example.com");
    expect(alice.emailHash).toEqual(expect.any(String));
  });
});

describe("buildDataset — cohérence", () => {
  it("should attach every trip to a demo account when trips are built", () => {
    const userIds = documentsOf("users").map((user) => String(user._id));

    const owners = documentsOf("trips").map((trip) => trip.ownerId);

    expect(owners.every((ownerId) => userIds.includes(ownerId))).toBe(true);
  });

  it("should attach every booking to an existing trip when bookings are built", () => {
    const tripIds = documentsOf("trips").map((trip) => String(trip._id));

    const attached = documentsOf("bookings").map((booking) => booking.tripId);

    expect(attached.every((tripId) => tripIds.includes(tripId))).toBe(true);
  });

  it("should place trip dates in the future when the reference date is given", () => {
    const trips = documentsOf("trips");

    expect(trips.every((trip) => trip.startDate > NOW)).toBe(true);
    expect(trips.every((trip) => trip.endDate > trip.startDate)).toBe(true);
  });

  it("should mirror the friendship when the relation is built", () => {
    const friends = documentsOf("friends");

    expect(friends).toHaveLength(2);
    expect(friends[0].userId).toBe(friends[1].friendId);
    expect(friends[1].userId).toBe(friends[0].friendId);
  });
});

describe("parseArgs", () => {
  it("should report an unknown option when the flag is not supported", () => {
    expect(parseArgs(["--reset"]).unknown).toEqual(["--reset"]);
  });

  it("should read force and clean when both flags are passed", () => {
    const options = parseArgs(["--force", "--clean"]);

    expect(options).toMatchObject({ force: true, clean: true, unknown: [] });
  });
});

describe("seed", () => {
  it("should insert every document when the database is empty", async () => {
    const result = await seed(db, dataset);

    expect(result.refused).toBeUndefined();
    expect(result.written).toEqual([
      { name: "users", created: 3, updated: 0 },
      { name: "trips", created: 2, updated: 0 },
      { name: "bookings", created: 4, updated: 0 },
      { name: "addresses", created: 3, updated: 0 },
      { name: "friends", created: 2, updated: 0 },
      { name: "subscriptions", created: 1, updated: 0 },
    ]);
  });

  it("should update instead of duplicating when run a second time", async () => {
    await seed(db, dataset);

    const result = await seed(db, dataset);

    expect(result.written.every((row) => row.created === 0)).toBe(true);
    expect(await db.collection("users").countDocuments()).toBe(3);
  });

  it("should restore a modified demo document when run again", async () => {
    await seed(db, dataset);
    await db
      .collection("trips")
      .updateOne({ _id: DEMO_IDS.trips.porto }, { $set: { title: "Titre modifié" } });

    await seed(db, dataset);

    const trip = await db.collection("trips").findOne({ _id: DEMO_IDS.trips.porto });
    expect(trip.title).toBe("Week-end à Porto");
  });

  it("should refuse when the database holds a document it did not write", async () => {
    await db.collection("trips").insertOne({ title: "Voyage d'un utilisateur" });

    const result = await seed(db, dataset);

    expect(result.written).toBeUndefined();
    expect(result.refused).toContain("trips (1)");
  });

  it("should write anyway when force is set on a populated database", async () => {
    await db.collection("trips").insertOne({ title: "Voyage d'un utilisateur" });

    const result = await seed(db, dataset, { force: true });

    expect(result.refused).toBeUndefined();
    expect(await db.collection("trips").countDocuments()).toBe(3);
  });

  it("should refuse when a demo address already belongs to another account", async () => {
    const [alice] = documentsOf("users");
    await db.collection("users").insertOne({ ...alice, _id: new ObjectId() });

    const result = await seed(db, dataset);

    expect(result.refused).toContain("adresse de démonstration");
  });

  it("should replace the conflicting account when force is set", async () => {
    const [alice] = documentsOf("users");
    await db.collection("users").insertOne({ ...alice, _id: new ObjectId() });

    await seed(db, dataset, { force: true });

    expect(await db.collection("users").countDocuments({ emailHash: alice.emailHash })).toBe(1);
  });
});

describe("foreignDocuments", () => {
  it("should list no collection when only the demo documents are present", async () => {
    await seed(db, dataset);

    expect(await foreignDocuments(db, dataset)).toEqual([]);
  });
});

describe("cleanDataset", () => {
  it("should remove the demo documents and leave the others when the database is mixed", async () => {
    await seed(db, dataset);
    await db.collection("trips").insertOne({ title: "Voyage d'un utilisateur" });

    const removed = await cleanDataset(db, dataset);

    expect(removed).toContainEqual({ name: "trips", deleted: 2 });
    expect(await db.collection("trips").countDocuments()).toBe(1);
  });
});

describe("formatSummary", () => {
  it("should describe creations and updates when a write bilan is given", () => {
    const output = formatSummary([{ name: "users", created: 3, updated: 0 }]);

    expect(output).toContain("3 créé(s), 0 mis à jour");
  });

  it("should describe deletions when a clean bilan is given", () => {
    const output = formatSummary([{ name: "users", deleted: 3 }]);

    expect(output).toContain("3 supprimé(s)");
  });
});

// Ces cas s'arrêtent tous avant l'ouverture de la connexion : aucun n'atteint
// une base réelle, ce qui les garde déterministes et hors-réseau.
describe("main — garde-fous", () => {
  let logSpy;
  let errorSpy;

  beforeEach(() => {
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("should succeed and print the usage when help is requested", async () => {
    await expect(main(["--help"])).resolves.toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Usage"));
  });

  it("should fail when an unknown option is passed", async () => {
    await expect(main(["--reset"])).resolves.toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Option inconnue"));
  });

  it("should fail when the connection string is not configured", async () => {
    const saved = process.env.MONGODB_URI;
    delete process.env.MONGODB_URI;

    await expect(main([])).resolves.toBe(1);

    process.env.MONGODB_URI = saved;
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("MONGODB_URI"));
  });

  it("should refuse to seed when the environment is production", async () => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";

    await expect(main([])).resolves.toBe(1);

    process.env.NODE_ENV = saved;
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("NODE_ENV=production"));
  });
});

// Chemin complet du script, connexion comprise, sur la base en mémoire : c'est
// le seul moyen de vérifier le code de sortie réellement rendu au shell.
describe("main — exécution complète", () => {
  let logSpy;
  let errorSpy;
  let savedUri;
  let savedDbName;

  beforeEach(() => {
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    savedUri = process.env.MONGODB_URI;
    savedDbName = process.env.DB_NAME;
    process.env.MONGODB_URI = mongod.getUri();
    process.env.DB_NAME = "seed-test";
  });

  afterEach(() => {
    process.env.MONGODB_URI = savedUri;
    if (savedDbName === undefined) delete process.env.DB_NAME;
    else process.env.DB_NAME = savedDbName;
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("should succeed and populate the database when the server answers", async () => {
    await expect(main([])).resolves.toBe(0);

    expect(await db.collection("users").countDocuments()).toBe(3);
  }, 30000);

  it("should remove the demo documents when clean is requested", async () => {
    await main([]);

    await expect(main(["--clean"])).resolves.toBe(0);

    expect(await db.collection("users").countDocuments()).toBe(0);
  }, 30000);

  it("should fail with an actionable message when no server listens", async () => {
    process.env.MONGODB_URI = "mongodb://127.0.0.1:1";

    await expect(main([])).resolves.toBe(1);

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Aucun serveur MongoDB n'écoute"));
  }, 30000);
});
