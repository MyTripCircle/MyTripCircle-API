const request = require("supertest");
const jwt = require("jsonwebtoken");
const { generateKeyPairSync } = require("node:crypto");
const { ObjectId } = require("mongodb");
const { createFakeDb } = require("../../__tests__/helpers/fakeDb");
const { createApp, silenceConsole } = require("../../__tests__/helpers/routerApp");

const USER_ID = "507f1f77bcf86cd799439011";
const APPLE_KID = "test-kid";

// Préfixe `mock` obligatoire : la factory de jest.mock est hoistée au-dessus des require.
const mockFakeDb = createFakeDb();
jest.mock("../../db", () => ({ getDb: () => mockFakeDb.db }));

jest.mock("../../middleware/rateLimiter", () => ({
  authLimiter: (_req, _res, next) => next(),
  generalLimiter: (_req, _res, next) => next(),
  searchLimiter: (_req, _res, next) => next(),
  iapLimiter: (_req, _res, next) => next(),
}));

const { encrypt } = require("../../utils/crypto");
const oauthRouter = require("../oauth");

describe("oauth router", () => {
  let app;
  let restoreConsole;
  let appleJwk;
  let appleIdentityToken;
  let tokenWithUnknownKid;

  beforeAll(() => {
    app = createApp("/users", oauthRouter);
    restoreConsole = silenceConsole();

    // Paire de clés locale : le token Apple est signé puis vérifié via la JWKS simulée.
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    appleJwk = { ...publicKey.export({ format: "jwk" }), kid: APPLE_KID, alg: "RS256", use: "sig" };
    const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
    appleIdentityToken = jwt.sign(
      { sub: "apple-user-1", email: "alice@privaterelay.appleid.com" },
      privatePem,
      { algorithm: "RS256", keyid: APPLE_KID, expiresIn: "1h" }
    );
    tokenWithUnknownKid = jwt.sign({ sub: "apple-user-1" }, privatePem, {
      algorithm: "RS256",
      keyid: "kid-inconnu",
      expiresIn: "1h",
    });
  });

  afterAll(() => {
    restoreConsole();
    delete global.fetch;
  });

  beforeEach(() => {
    mockFakeDb.reset();
    global.fetch = jest.fn();
  });

  describe("POST /users/google", () => {
    const googleProfile = {
      sub: "google-1",
      email: "alice@test.com",
      name: "Alice",
      picture: "https://cdn.test/alice.png",
    };

    it("should return 400 when the access token is missing", async () => {
      // Act
      const res = await request(app).post("/users/google").send({});

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Missing accessToken");
    });

    it("should return 401 when Google rejects the access token", async () => {
      // Arrange
      global.fetch.mockResolvedValue({ ok: false });

      // Act
      const res = await request(app).post("/users/google").send({ accessToken: "token" });

      // Assert
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Invalid Google token");
    });

    it("should return 400 when Google returns no email", async () => {
      // Arrange
      global.fetch.mockResolvedValue({ ok: true, json: async () => ({ sub: "google-1" }) });

      // Act
      const res = await request(app).post("/users/google").send({ accessToken: "token" });

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("No email returned from Google");
    });

    it("should return 404 in login mode when no account matches", async () => {
      // Arrange
      global.fetch.mockResolvedValue({ ok: true, json: async () => googleProfile });
      mockFakeDb.col("users").findOne.mockResolvedValue(null);

      // Act
      const res = await request(app)
        .post("/users/google")
        .send({ accessToken: "token", mode: "login" });

      // Assert
      expect(res.status).toBe(404);
    });

    it("should create the account in register mode and flag it as new", async () => {
      // Arrange
      global.fetch.mockResolvedValue({ ok: true, json: async () => googleProfile });
      mockFakeDb.col("users").findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ _id: new ObjectId(USER_ID), name: encrypt("Alice"), verified: true });
      mockFakeDb.col("users").insertOne.mockResolvedValue({ insertedId: new ObjectId(USER_ID) });

      // Act
      const res = await request(app).post("/users/google").send({ accessToken: "token" });

      // Assert
      expect(res.body).toMatchObject({ success: true, isNewUser: true });
      expect(res.body.user.name).toBe("Alice");
      const [inserted] = mockFakeDb.col("users").insertOne.mock.calls[0];
      expect(inserted.email).not.toBe("alice@test.com");
      expect(inserted.verified).toBe(true);
    });

    it("should link the Google id to an existing account matched by email", async () => {
      // Arrange
      global.fetch.mockResolvedValue({ ok: true, json: async () => googleProfile });
      mockFakeDb.col("users").findOne.mockResolvedValue({ _id: new ObjectId(USER_ID) });

      // Act
      const res = await request(app).post("/users/google").send({ accessToken: "token" });

      // Assert
      expect(res.body.isNewUser).toBe(false);
      expect(mockFakeDb.col("users").updateOne).toHaveBeenCalledWith(
        { _id: new ObjectId(USER_ID) },
        { $set: { googleId: "google-1" } }
      );
    });

    it("should not relink an account that already carries the Google id", async () => {
      // Arrange
      global.fetch.mockResolvedValue({ ok: true, json: async () => googleProfile });
      mockFakeDb.col("users").findOne.mockResolvedValue({
        _id: new ObjectId(USER_ID),
        googleId: "google-1",
      });

      // Act
      const res = await request(app).post("/users/google").send({ accessToken: "token" });

      // Assert
      expect(res.body.success).toBe(true);
      expect(mockFakeDb.col("users").updateOne).not.toHaveBeenCalled();
    });

    it("should return 500 when the Google call fails", async () => {
      // Arrange
      global.fetch.mockRejectedValue(new Error("network down"));

      // Act
      const res = await request(app).post("/users/google").send({ accessToken: "token" });

      // Assert
      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Google authentication failed");
    });
  });

  describe("POST /users/apple", () => {
    let appleApp;

    // Le routeur met les clés Apple en cache pendant une heure : on le recharge
    // avant chaque test pour repartir d'un cache vide, quel que soit l'ordre
    // d'exécution des tests.
    beforeEach(() => {
      jest.isolateModules(() => {
        appleApp = createApp("/users", require("../oauth"));
      });
      global.fetch.mockResolvedValue({ ok: true, json: async () => ({ keys: [appleJwk] }) });
    });

    it("should return 400 when the identity token is missing", async () => {
      // Act
      const res = await request(appleApp).post("/users/apple").send({});

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Missing identityToken");
    });

    it("should return 401 when the identity token is not a JWT", async () => {
      // Act
      const res = await request(appleApp).post("/users/apple").send({ identityToken: "abc" });

      // Assert
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Invalid Apple token");
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should return 401 when the Apple public keys cannot be fetched", async () => {
      // Arrange
      global.fetch.mockResolvedValue({ ok: false });

      // Act
      const res = await request(appleApp)
        .post("/users/apple")
        .send({ identityToken: appleIdentityToken });

      // Assert
      expect(res.status).toBe(401);
    });

    it("should return 401 when no published key matches the token", async () => {
      // Act
      const res = await request(appleApp)
        .post("/users/apple")
        .send({ identityToken: tokenWithUnknownKid });

      // Assert
      expect(res.status).toBe(401);
    });

    it("should return 404 in login mode when no account matches", async () => {
      // Arrange
      mockFakeDb.col("users").findOne.mockResolvedValue(null);

      // Act
      const res = await request(appleApp)
        .post("/users/apple")
        .send({ identityToken: appleIdentityToken, mode: "login" });

      // Assert
      expect(res.status).toBe(404);
    });

    it("should build the account name from the full name sent by the device", async () => {
      // Arrange
      mockFakeDb.col("users").findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ _id: new ObjectId(USER_ID), name: encrypt("Alice Martin") });
      mockFakeDb.col("users").insertOne.mockResolvedValue({ insertedId: new ObjectId(USER_ID) });

      // Act
      const res = await request(appleApp).post("/users/apple").send({
        identityToken: appleIdentityToken,
        fullName: { givenName: "Alice", familyName: "Martin" },
      });

      // Assert
      expect(res.body.isNewUser).toBe(true);
      const [inserted] = mockFakeDb.col("users").insertOne.mock.calls[0];
      expect(inserted.appleId).toBe("apple-user-1");
    });

    it("should link the Apple id to an existing account", async () => {
      // Arrange
      mockFakeDb.col("users").findOne.mockResolvedValue({ _id: new ObjectId(USER_ID) });

      // Act
      const res = await request(appleApp)
        .post("/users/apple")
        .send({ identityToken: appleIdentityToken });

      // Assert
      expect(res.body.isNewUser).toBe(false);
      expect(mockFakeDb.col("users").updateOne).toHaveBeenCalledWith(
        { _id: new ObjectId(USER_ID) },
        { $set: { appleId: "apple-user-1" } }
      );
    });

    it("should fetch the Apple keys only once for two consecutive sign-ins", async () => {
      // Arrange
      mockFakeDb.col("users").findOne.mockResolvedValue({
        _id: new ObjectId(USER_ID),
        appleId: "apple-user-1",
      });

      // Act
      await request(appleApp).post("/users/apple").send({ identityToken: appleIdentityToken });
      const res = await request(appleApp)
        .post("/users/apple")
        .send({ identityToken: appleIdentityToken });

      // Assert
      expect(res.body.success).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it("should return 500 when the database fails", async () => {
      // Arrange
      mockFakeDb.col("users").findOne.mockRejectedValue(new Error("mongo down"));

      // Act
      const res = await request(appleApp)
        .post("/users/apple")
        .send({ identityToken: appleIdentityToken });

      // Assert
      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Apple authentication failed");
    });
  });
});
