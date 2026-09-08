const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");

const {
  CRITICAL_INDEXES,
  sameKey,
  findMissingIndexes,
  inspect,
  formatReport,
  main,
} = require("../test-connection");

let mongod;
let client;
let db;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db("connection-test");
}, 60000);

beforeEach(async () => {
  await db.dropDatabase();
});

afterAll(async () => {
  if (client) await client.close();
  if (mongod) await mongod.stop();
});

/** Crée les index critiques, comme le fait `server/db.js` au démarrage. */
async function createCriticalIndexes() {
  for (const { collection, key } of CRITICAL_INDEXES) {
    await db.collection(collection).createIndex(key);
  }
}

describe("sameKey", () => {
  it("should match when both keys carry the same field in the same order", () => {
    expect(sameKey({ createdAt: 1 }, { createdAt: 1 })).toBe(true);
  });

  it("should not match when the compared key holds an extra field", () => {
    expect(sameKey({ city: 1 }, { city: 1, days: 1 })).toBe(false);
  });

  it("should not match when the sort direction differs", () => {
    expect(sameKey({ createdAt: 1 }, { createdAt: -1 })).toBe(false);
  });
});

describe("findMissingIndexes", () => {
  it("should report every expected index when the database declares none", () => {
    expect(findMissingIndexes({})).toHaveLength(CRITICAL_INDEXES.length);
  });

  it("should ignore the index name when the key matches", () => {
    const declared = { users: [{ name: "index_pose_a_la_main", key: { emailHash: 1 } }] };

    const missing = findMissingIndexes(declared);

    expect(missing.some((index) => index.collection === "users" && index.key.emailHash)).toBe(false);
  });
});

describe("inspect", () => {
  it("should count the documents of each collection when the database answers", async () => {
    await db.collection("trips").insertMany([{ title: "A" }, { title: "B" }]);

    const report = await inspect(db);

    expect(report.collections).toEqual([{ name: "trips", count: 2 }]);
    expect(report.pingMs).toEqual(expect.any(Number));
  });

  it("should report no missing index when every critical index exists", async () => {
    await createCriticalIndexes();

    const report = await inspect(db);

    expect(report.missingIndexes).toEqual([]);
  });

  it("should report the missing index when one critical index is absent", async () => {
    await createCriticalIndexes();
    await db.collection("users").dropIndex({ emailHash: 1 });

    const report = await inspect(db);

    expect(report.missingIndexes).toEqual([
      expect.objectContaining({ collection: "users", key: { emailHash: 1 } }),
    ]);
  });
});

describe("formatReport", () => {
  it("should state that the database is empty when no collection exists", () => {
    const report = { pingMs: 3, collections: [], missingIndexes: [] };

    const output = formatReport(report, "mytripcircle", "mongodb://127.0.0.1:27017");

    expect(output).toContain("base vierge");
  });

  it("should hide the credentials when the connection string carries them", () => {
    const report = { pingMs: 3, collections: [], missingIndexes: [] };

    const output = formatReport(report, "mytripcircle", "mongodb+srv://user:motdepasse@cluster.example.net/");

    expect(output).not.toContain("motdepasse");
    expect(output).toContain("cluster.example.net");
  });

  it("should tell how to create the indexes when one is missing", () => {
    const report = { pingMs: 3, collections: [], missingIndexes: [CRITICAL_INDEXES[0]] };

    const output = formatReport(report, "mytripcircle", "mongodb://127.0.0.1:27017");

    expect(output).toContain("npm run server");
  });
});

// Le seul chemin de `main` testable sans base : celui qui s'arrête avant même
// d'ouvrir une connexion.
describe("main — garde-fous", () => {
  it("should fail when the connection string is not configured", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const saved = process.env.MONGODB_URI;
    delete process.env.MONGODB_URI;

    await expect(main()).resolves.toBe(1);

    process.env.MONGODB_URI = saved;
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("MONGODB_URI"));
    errorSpy.mockRestore();
  });
});

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
    process.env.DB_NAME = "connection-test";
  });

  afterEach(() => {
    process.env.MONGODB_URI = savedUri;
    if (savedDbName === undefined) delete process.env.DB_NAME;
    else process.env.DB_NAME = savedDbName;
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("should exit in error when a critical index is missing", async () => {
    await expect(main()).resolves.toBe(1);

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("index critiques sont absents"));
  }, 30000);

  it("should exit in success when every critical index exists", async () => {
    await createCriticalIndexes();

    await expect(main()).resolves.toBe(0);
  }, 30000);

  it("should fail with an actionable message when no server listens", async () => {
    process.env.MONGODB_URI = "mongodb://127.0.0.1:1";

    await expect(main()).resolves.toBe(1);

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Aucun serveur MongoDB n'écoute"));
  }, 30000);
});
