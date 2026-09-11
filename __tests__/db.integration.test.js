const { MongoClient } = require("mongodb");
const { MongoMemoryServer } = require("mongodb-memory-server");

// Le validateur de `users` n'a de sens que face au moteur qui l'applique : ces
// tests tournent donc sur un MongoDB en mémoire, pas sur la base factice.
// Chaque cas utilise sa propre base, pour que l'état laissé par l'un ne décide
// pas du résultat du suivant.

// Code d'erreur MongoDB d'un document refusé par le validateur.
const DOCUMENT_VALIDATION_FAILURE = 121;

let mongod;
let admin;
let dbModule;
let dbName;
let caseIndex = 0;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  // Client indépendant du module testé : il prépare l'état initial et
  // l'inspecte sans passer par le code dont on vérifie le comportement.
  admin = await MongoClient.connect(mongod.getUri());
}, 60000);

beforeEach(() => {
  caseIndex += 1;
  dbName = `validator-case-${caseIndex}`;
});

afterEach(async () => {
  if (dbModule) await dbModule.closeMongo();
  dbModule = undefined;
});

afterAll(async () => {
  await admin.close();
  await mongod.stop();
});

// Démarre la couche d'accès aux données comme le fait le serveur. config.js
// fige l'URI et le nom de base au require : le cache de modules est vidé à
// chaque démarrage pour qu'ils soient relus.
async function startDataLayer() {
  process.env.MONGODB_URI = mongod.getUri();
  process.env.DB_NAME = dbName;
  jest.resetModules();
  dbModule = require("../db");
  await dbModule.connectMongo();
  return dbModule.getDb();
}

async function readUsersOptions() {
  const [info] = await admin
    .db(dbName)
    .listCollections({ name: "users" }, { nameOnly: false })
    .toArray();
  return info.options;
}

describe("Validateur de la collection users", () => {
  it("should create users with a strict, rejecting validator on a fresh database", async () => {
    // Act
    await startDataLayer();

    // Assert
    const options = await readUsersOptions();
    expect(options.validationLevel).toBe("strict");
    expect(options.validationAction).toBe("error");
    expect(options.validator.$jsonSchema.required).toEqual(["name", "createdAt"]);
  });

  it("should still create the unique emailHash index once the validator is set", async () => {
    // Act
    await startDataLayer();

    // Assert
    const indexes = await admin.db(dbName).collection("users").indexes();
    const emailHash = indexes.find((index) => index.name === "emailHash_1");
    expect(emailHash).toMatchObject({ unique: true, sparse: true });
  });

  it("should reject a user without a creation date", async () => {
    // Arrange
    const db = await startDataLayer();

    // Act
    const insertion = db.collection("users").insertOne({ name: "Sans date" });

    // Assert
    await expect(insertion).rejects.toMatchObject({ code: DOCUMENT_VALIDATION_FAILURE });
  });

  it("should reject a user whose name is not a string", async () => {
    // Arrange
    const db = await startDataLayer();

    // Act
    const insertion = db.collection("users").insertOne({ name: 42, createdAt: new Date() });

    // Assert
    await expect(insertion).rejects.toMatchObject({ code: DOCUMENT_VALIDATION_FAILURE });
  });

  it("should accept a user as the server writes it, email encrypted", async () => {
    // Arrange
    const db = await startDataLayer();
    const { encryptUserFields } = require("../utils/crypto");
    const user = encryptUserFields({
      name: "Inscription courriel",
      email: "courriel@test.local",
      password: "$2b$10$empreinte-bcrypt-factice",
      phone: "",
      verified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Act
    const insertion = db.collection("users").insertOne(user);

    // Assert
    await expect(insertion).resolves.toHaveProperty("insertedId");
  });

  it("should accept a Sign in with Apple user who shared no email address", async () => {
    // Arrange
    const db = await startDataLayer();
    const { encryptUserFields } = require("../utils/crypto");
    const user = encryptUserFields({
      name: "User",
      email: null,
      appleId: "apple-sub",
      verified: true,
      createdAt: new Date(),
    });

    // Act
    const insertion = db.collection("users").insertOne(user);

    // Assert
    await expect(insertion).resolves.toHaveProperty("insertedId");
  });

  it("should leave the validator unchanged across restarts", async () => {
    // Arrange
    await startDataLayer();
    const before = await readUsersOptions();
    await dbModule.closeMongo();

    // Act
    await startDataLayer();

    // Assert
    expect(await readUsersOptions()).toEqual(before);
  });

  it("should add the validator in moderate mode to an existing collection without one", async () => {
    // Arrange — un compte antérieur au validateur, qui ne respecte pas le schéma
    await admin.db(dbName).collection("users").insertOne({ legacy: true });

    // Act
    const db = await startDataLayer();

    // Assert
    const options = await readUsersOptions();
    expect(options.validationLevel).toBe("moderate");
    expect(options.validator.$jsonSchema.required).toEqual(["name", "createdAt"]);
    await expect(
      db.collection("users").updateOne({ legacy: true }, { $set: { updatedAt: new Date() } })
    ).resolves.toMatchObject({ modifiedCount: 1 });
    await expect(
      db.collection("users").insertOne({ name: "Sans date" })
    ).rejects.toMatchObject({ code: DOCUMENT_VALIDATION_FAILURE });
  });

  it("should only make phone and email nullable when a validator already exists", async () => {
    // Arrange — le validateur relevé en production le 11/09, posé hors du
    // serveur en 2025 : email requis et typé chaîne seule
    await createProductionValidator();

    // Act
    await startDataLayer();

    // Assert
    const schema = (await readUsersOptions()).validator.$jsonSchema;
    expect(schema.required).toEqual(["email", "name", "createdAt"]);
    expect(schema.properties.email).toEqual({ bsonType: ["string", "null"] });
    expect(schema.properties.phone).toEqual({ bsonType: ["string", "null"] });
  });

  it("should accept a Sign in with Apple user without email once a production validator is aligned", async () => {
    // Arrange
    await createProductionValidator();
    const db = await startDataLayer();
    const { encryptUserFields } = require("../utils/crypto");
    const user = encryptUserFields({
      name: "User",
      email: null,
      appleId: "apple-sub",
      verified: true,
      createdAt: new Date(),
    });

    // Act
    const insertion = db.collection("users").insertOne(user);

    // Assert — avant alignement, le moteur rejetait ce compte (D-24)
    await expect(insertion).resolves.toHaveProperty("insertedId");
  });
});

// Validateur de production tel que relevé le 11/09/2026.
function createProductionValidator() {
  return admin.db(dbName).createCollection("users", {
    validator: {
      $jsonSchema: {
        bsonType: "object",
        required: ["email", "name", "createdAt"],
        properties: {
          email: { bsonType: "string" },
          phone: { bsonType: ["string", "null"] },
        },
      },
    },
    validationLevel: "strict",
    validationAction: "error",
  });
}
