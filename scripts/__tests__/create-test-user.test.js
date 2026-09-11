// Clés factices, fixées avant tout appel aux utilitaires de chiffrement : le
// compte est chiffré avec les mêmes fonctions que le serveur.
process.env.ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.HMAC_KEY =
  "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");

const { hashField, decryptUserFields } = require("../../utils/crypto");
const { parseArgs, upsertTestUser, deleteTestUser, main } = require("../create-test-user");

const NOW = new Date("2026-01-15T10:00:00.000Z");
const EMAIL = "charge@test.local";

let mongod;
let client;
let db;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db("test-user");
}, 60000);

beforeEach(async () => {
  await db.dropDatabase();
});

afterAll(async () => {
  if (client) await client.close();
  if (mongod) await mongod.stop();
});

describe("parseArgs", () => {
  it("should fall back to the TEST_* variables, then to the defaults", () => {
    expect(parseArgs([], { TEST_EMAIL: "Env@Test.Local" })).toEqual({
      remove: false,
      email: "env@test.local",
      password: "LoadTest!42",
      name: "Load Test",
    });
  });

  it("should read the address after --delete", () => {
    expect(parseArgs(["--delete", EMAIL], {})).toMatchObject({ remove: true, email: EMAIL });
  });
});

describe("upsertTestUser", () => {
  it("should create a verified account with encrypted fields", async () => {
    // Act
    const outcome = await upsertTestUser(db, { email: EMAIL, name: "Charge", passwordHash: "h", now: NOW });

    // Assert
    expect(outcome).toBe("created");
    const stored = await db.collection("users").findOne({ emailHash: hashField(EMAIL) });
    expect(stored.email).not.toBe(EMAIL);
    expect(decryptUserFields(stored)).toMatchObject({ email: EMAIL, name: "Charge", verified: true });
  });

  it("should reset the password of an existing account instead of duplicating it", async () => {
    // Arrange
    await upsertTestUser(db, { email: EMAIL, name: "Charge", passwordHash: "ancien", now: NOW });
    await db.collection("users").updateOne({}, { $set: { verified: false } });

    // Act
    const outcome = await upsertTestUser(db, { email: EMAIL, name: "Charge", passwordHash: "nouveau", now: NOW });

    // Assert
    expect(outcome).toBe("updated");
    expect(await db.collection("users").countDocuments()).toBe(1);
    expect(await db.collection("users").findOne({})).toMatchObject({ password: "nouveau", verified: true });
  });
});

describe("deleteTestUser", () => {
  it("should report whether an account was removed", async () => {
    // Arrange
    await upsertTestUser(db, { email: EMAIL, name: "Charge", passwordHash: "h", now: NOW });

    // Act / Assert
    await expect(deleteTestUser(db, EMAIL)).resolves.toBe(true);
    await expect(deleteTestUser(db, EMAIL)).resolves.toBe(false);
  });
});

describe("main", () => {
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
    process.env.DB_NAME = "test-user";
  });

  afterEach(() => {
    if (savedUri === undefined) delete process.env.MONGODB_URI;
    else process.env.MONGODB_URI = savedUri;
    if (savedDbName === undefined) delete process.env.DB_NAME;
    else process.env.DB_NAME = savedDbName;
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("should create then delete the account through the command line", async () => {
    await expect(main([EMAIL, "Charge!2026"])).resolves.toBe(0);
    expect(await db.collection("users").countDocuments()).toBe(1);

    await expect(main(["--delete", EMAIL])).resolves.toBe(0);
    expect(await db.collection("users").countDocuments()).toBe(0);
  }, 30000);

  it("should refuse a weak password before touching the database", async () => {
    await expect(main([EMAIL, "faible"])).resolves.toBe(1);

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("trop faible"));
    expect(await db.collection("users").countDocuments()).toBe(0);
  });

  it("should fail when the connection string is not configured", async () => {
    delete process.env.MONGODB_URI;

    await expect(main([EMAIL])).resolves.toBe(1);

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("MONGODB_URI"));
  });

  it("should fail cleanly when the server does not answer", async () => {
    process.env.MONGODB_URI = "mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=200";

    await expect(main([EMAIL, "Charge!2026"])).resolves.toBe(1);

    expect(errorSpy).toHaveBeenCalledWith("❌ Opération impossible.");
  }, 30000);
});
