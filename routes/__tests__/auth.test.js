const request = require("supertest");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { ObjectId } = require("mongodb");
const { createFakeDb } = require("../../__tests__/helpers/fakeDb");
const { createApp, silenceConsole } = require("../../__tests__/helpers/routerApp");

const USER_ID = "507f1f77bcf86cd799439011";
const PASSWORD = "Abcd1234!";

// Préfixe `mock` obligatoire : la factory de jest.mock est hoistée au-dessus des require.
const mockFakeDb = createFakeDb();
jest.mock("../../db", () => ({ getDb: () => mockFakeDb.db }));

jest.mock("../../middleware/rateLimiter", () => ({
  authLimiter: (_req, _res, next) => next(),
  generalLimiter: (_req, _res, next) => next(),
  searchLimiter: (_req, _res, next) => next(),
  iapLimiter: (_req, _res, next) => next(),
}));

jest.mock("../../utils/email", () => ({ sendOtpEmail: jest.fn() }));
jest.mock("../friends", () => ({ linkPendingFriendRequests: jest.fn() }));

const { sendOtpEmail } = require("../../utils/email");
const { linkPendingFriendRequests } = require("../friends");
const { encrypt, hashField } = require("../../utils/crypto");
const { REFRESH_SECRET } = require("../../config");
const { hashToken } = require("../../utils/authHelpers");
const { router: authRouter } = require("../auth");

const IN_TEN_MINUTES = () => new Date(Date.now() + 10 * 60 * 1000);
const TEN_MINUTES_AGO = () => new Date(Date.now() - 10 * 60 * 1000);

describe("auth router", () => {
  let app;
  let restoreConsole;
  let passwordHash;

  beforeAll(async () => {
    app = createApp("/users", authRouter);
    restoreConsole = silenceConsole();
    passwordHash = await bcrypt.hash(PASSWORD, 10);
  });

  afterAll(() => restoreConsole());

  beforeEach(() => {
    mockFakeDb.reset();
    jest.clearAllMocks();
  });

  describe("POST /users/register", () => {
    const validBody = { name: "Alice", email: "Alice@Test.com", password: PASSWORD };

    it("should return 400 when a required field is missing", async () => {
      // Act
      const res = await request(app).post("/users/register").send({ name: "Alice" });

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Champs requis manquants");
    });

    it("should return 400 when the email format is invalid", async () => {
      // Act
      const res = await request(app)
        .post("/users/register")
        .send({ ...validBody, email: "pas-un-email" });

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.field).toBe("email");
    });

    it("should return 400 when the password is too weak", async () => {
      // Act
      const res = await request(app)
        .post("/users/register")
        .send({ ...validBody, password: "faible" });

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.field).toBe("password");
    });

    it("should return 400 when the phone format is invalid", async () => {
      // Act
      const res = await request(app).post("/users/register").send({ ...validBody, phone: "abc" });

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.field).toBe("phone");
    });

    it("should return 409 when the phone is already used by a verified account", async () => {
      // Arrange
      mockFakeDb.col("users").findOne.mockResolvedValue({ _id: new ObjectId() });

      // Act
      const res = await request(app)
        .post("/users/register")
        .send({ ...validBody, phone: "+33612345678" });

      // Assert
      expect(res.status).toBe(409);
      expect(res.body.field).toBe("phone");
    });

    it("should resend a code when the account exists but is not verified", async () => {
      // Arrange
      mockFakeDb.col("users").findOne.mockResolvedValue({
        _id: new ObjectId(USER_ID),
        verified: false,
      });

      // Act
      const res = await request(app).post("/users/register").send(validBody);

      // Assert
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: false, requiresOtp: true, userId: USER_ID });
      expect(sendOtpEmail).toHaveBeenCalledWith("alice@test.com", expect.stringMatching(/^\d{6}$/));
    });

    it("should return 409 when the email belongs to a verified account", async () => {
      // Arrange
      mockFakeDb.col("users").findOne.mockResolvedValue({
        _id: new ObjectId(USER_ID),
        verified: true,
      });

      // Act
      const res = await request(app).post("/users/register").send(validBody);

      // Assert
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("Email déjà utilisé");
    });

    it("should create the account with an encrypted email and send the code", async () => {
      // Arrange
      mockFakeDb.col("users").findOne.mockResolvedValue(null);
      mockFakeDb.col("users").insertOne.mockResolvedValue({ insertedId: new ObjectId(USER_ID) });

      // Act
      const res = await request(app).post("/users/register").send(validBody);

      // Assert
      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        success: true,
        userId: USER_ID,
        message: "Code envoyé par email",
      });
      const [inserted] = mockFakeDb.col("users").insertOne.mock.calls[0];
      expect(inserted.emailHash).toBe(hashField("alice@test.com"));
      expect(inserted.email).not.toBe("alice@test.com");
      expect(inserted.verified).toBe(false);
    });

    it("should return 500 when the database fails", async () => {
      // Arrange
      mockFakeDb.col("users").findOne.mockRejectedValue(new Error("mongo down"));

      // Act
      const res = await request(app).post("/users/register").send(validBody);

      // Assert
      expect(res.status).toBe(500);
    });
  });

  describe("POST /users/login", () => {
    const credentials = { email: "alice@test.com", password: PASSWORD };

    it("should return 400 when a field is missing", async () => {
      // Act
      const res = await request(app).post("/users/login").send({ email: "alice@test.com" });

      // Assert
      expect(res.status).toBe(400);
    });

    it("should return 401 when the email format is invalid", async () => {
      // Act
      const res = await request(app)
        .post("/users/login")
        .send({ email: "pas-un-email", password: PASSWORD });

      // Assert
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Identifiants invalides");
    });

    it("should return 401 when no account matches the email", async () => {
      // Arrange
      mockFakeDb.col("users").findOne.mockResolvedValue(null);

      // Act
      const res = await request(app).post("/users/login").send(credentials);

      // Assert
      expect(res.status).toBe(401);
    });

    it("should return 401 when the password does not match", async () => {
      // Arrange
      mockFakeDb.col("users").findOne.mockResolvedValue({
        _id: new ObjectId(USER_ID),
        password: passwordHash,
        verified: true,
      });

      // Act
      const res = await request(app)
        .post("/users/login")
        .send({ ...credentials, password: "Autre123!" });

      // Assert
      expect(res.status).toBe(401);
    });

    it("should ask for the pending code when the account is not verified yet", async () => {
      // Arrange
      mockFakeDb.col("users").findOne.mockResolvedValue({
        _id: new ObjectId(USER_ID),
        password: passwordHash,
        verified: false,
        otp: "123456",
        otpExpiresAt: IN_TEN_MINUTES(),
      });

      // Act
      const res = await request(app).post("/users/login").send(credentials);

      // Assert
      expect(res.status).toBe(403);
      expect(res.body.requiresOtp).toBe(true);
      expect(sendOtpEmail).not.toHaveBeenCalled();
    });

    it("should send a new code when the pending one has expired", async () => {
      // Arrange
      mockFakeDb.col("users").findOne.mockResolvedValue({
        _id: new ObjectId(USER_ID),
        password: passwordHash,
        email: encrypt("alice@test.com"),
        verified: false,
        otp: "123456",
        otpExpiresAt: TEN_MINUTES_AGO(),
      });

      // Act
      const res = await request(app).post("/users/login").send(credentials);

      // Assert
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("Code expiré. Un nouveau code a été envoyé.");
      expect(sendOtpEmail).toHaveBeenCalledWith("alice@test.com", expect.stringMatching(/^\d{6}$/));
    });

    it("should return an access token and a refresh token on success", async () => {
      // Arrange
      mockFakeDb.col("users").findOne.mockResolvedValue({
        _id: new ObjectId(USER_ID),
        passwordHash,
        email: encrypt("alice@test.com"),
        name: encrypt("Alice"),
        verified: true,
      });

      // Act
      const res = await request(app).post("/users/login").send(credentials);

      // Assert
      expect(res.body.success).toBe(true);
      expect(res.body.user).toMatchObject({ id: USER_ID, name: "Alice", verified: true });
      expect(jwt.verify(res.body.refreshToken, REFRESH_SECRET).id).toBe(USER_ID);
    });

    it("should return 500 when the database fails", async () => {
      // Arrange
      mockFakeDb.col("users").findOne.mockRejectedValue(new Error("mongo down"));

      // Act
      const res = await request(app).post("/users/login").send(credentials);

      // Assert
      expect(res.status).toBe(500);
    });
  });

  describe("POST /users/verify-otp", () => {
    it("should return 400 when userId or otp is missing", async () => {
      // Act
      const res = await request(app).post("/users/verify-otp").send({ userId: USER_ID });

      // Assert
      expect(res.status).toBe(400);
    });

    it("should return 404 when the user does not exist", async () => {
      // Arrange
      mockFakeDb.col("users").findOne.mockResolvedValue(null);

      // Act
      const res = await request(app)
        .post("/users/verify-otp")
        .send({ userId: USER_ID, otp: "123456" });

      // Assert
      expect(res.status).toBe(404);
    });

    it("should return 400 when the code does not match", async () => {
      // Arrange
      mockFakeDb.col("users").findOne.mockResolvedValue({ _id: new ObjectId(USER_ID), otp: "999999" });

      // Act
      const res = await request(app)
        .post("/users/verify-otp")
        .send({ userId: USER_ID, otp: "123456" });

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Code invalide");
    });

    it("should return 400 when the code has expired", async () => {
      // Arrange
      mockFakeDb.col("users").findOne.mockResolvedValue({
        _id: new ObjectId(USER_ID),
        otp: "123456",
        otpExpiresAt: TEN_MINUTES_AGO(),
      });

      // Act
      const res = await request(app)
        .post("/users/verify-otp")
        .send({ userId: USER_ID, otp: "123456" });

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Code expiré");
    });

    it("should verify the account and link the pending friend requests", async () => {
      // Arrange
      mockFakeDb.col("users").findOne.mockResolvedValue({
        _id: new ObjectId(USER_ID),
        otp: "123456",
        otpExpiresAt: IN_TEN_MINUTES(),
        email: encrypt("alice@test.com"),
        phone: encrypt("+33612345678"),
      });

      // Act
      const res = await request(app)
        .post("/users/verify-otp")
        .send({ userId: USER_ID, otp: "123456" });

      // Assert
      expect(res.body.success).toBe(true);
      expect(linkPendingFriendRequests).toHaveBeenCalledWith(
        USER_ID,
        "alice@test.com",
        "+33612345678"
      );
      const [, update] = mockFakeDb.col("users").updateOne.mock.calls[0];
      expect(update.$set.verified).toBe(true);
    });

    it("should return 500 when the database fails", async () => {
      // Arrange
      mockFakeDb.col("users").findOne.mockRejectedValue(new Error("mongo down"));

      // Act
      const res = await request(app)
        .post("/users/verify-otp")
        .send({ userId: USER_ID, otp: "123456" });

      // Assert
      expect(res.status).toBe(500);
    });
  });

  describe("POST /users/resend-otp", () => {
    it("should return 400 when userId is missing", async () => {
      // Act
      const res = await request(app).post("/users/resend-otp").send({});

      // Assert
      expect(res.status).toBe(400);
    });

    it("should return 404 when the user does not exist", async () => {
      // Arrange
      mockFakeDb.col("users").findOne.mockResolvedValue(null);

      // Act
      const res = await request(app).post("/users/resend-otp").send({ userId: USER_ID });

      // Assert
      expect(res.status).toBe(404);
    });

    it("should return 400 when the account is already verified", async () => {
      // Arrange
      mockFakeDb.col("users").findOne.mockResolvedValue({
        _id: new ObjectId(USER_ID),
        verified: true,
      });

      // Act
      const res = await request(app).post("/users/resend-otp").send({ userId: USER_ID });

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Compte déjà vérifié");
    });

    it("should store and send a fresh six-digit code", async () => {
      // Arrange
      mockFakeDb.col("users").findOne.mockResolvedValue({
        _id: new ObjectId(USER_ID),
        verified: false,
        email: encrypt("alice@test.com"),
      });

      // Act
      const res = await request(app).post("/users/resend-otp").send({ userId: USER_ID });

      // Assert
      expect(res.body).toEqual({ success: true, message: "Code renvoyé" });
      const [, update] = mockFakeDb.col("users").updateOne.mock.calls[0];
      expect(update.$set.otp).toMatch(/^\d{6}$/);
    });

    it("should return 500 when the database fails", async () => {
      // Arrange
      mockFakeDb.col("users").findOne.mockRejectedValue(new Error("mongo down"));

      // Act
      const res = await request(app).post("/users/resend-otp").send({ userId: USER_ID });

      // Assert
      expect(res.status).toBe(500);
    });
  });

  describe("POST /users/refresh", () => {
    it("should return 400 when the refresh token is missing", async () => {
      // Act
      const res = await request(app).post("/users/refresh").send({});

      // Assert
      expect(res.status).toBe(400);
    });

    it("should return 401 when the refresh token cannot be verified", async () => {
      // Act
      const res = await request(app).post("/users/refresh").send({ refreshToken: "pas-un-jwt" });

      // Assert
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Token invalide ou expiré");
    });

    it("should return 401 when the refresh token has been revoked", async () => {
      // Arrange
      const refreshToken = jwt.sign({ id: USER_ID }, REFRESH_SECRET, { expiresIn: "7d" });
      mockFakeDb.col("refreshTokens").findOne.mockResolvedValue(null);

      // Act
      const res = await request(app).post("/users/refresh").send({ refreshToken });

      // Assert
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Token invalide ou révoqué");
    });

    it("should rotate the refresh token when it is still valid", async () => {
      // Arrange
      const refreshToken = jwt.sign({ id: USER_ID }, REFRESH_SECRET, { expiresIn: "7d" });
      mockFakeDb.col("refreshTokens").findOne.mockResolvedValue({ token: hashToken(refreshToken) });

      // Act
      const res = await request(app).post("/users/refresh").send({ refreshToken });

      // Assert
      expect(res.body.success).toBe(true);
      expect(mockFakeDb.col("refreshTokens").deleteOne).toHaveBeenCalledWith({
        token: hashToken(refreshToken),
      });
      expect(mockFakeDb.col("refreshTokens").insertOne).toHaveBeenCalledWith(
        expect.objectContaining({ token: hashToken(res.body.refreshToken), userId: USER_ID })
      );
    });
  });

  describe("POST /users/logout", () => {
    it("should succeed without touching the database when no token is sent", async () => {
      // Act
      const res = await request(app).post("/users/logout").send({});

      // Assert
      expect(res.body).toEqual({ success: true });
      expect(mockFakeDb.col("refreshTokens").deleteOne).not.toHaveBeenCalled();
    });

    it("should delete the stored hash of the provided refresh token", async () => {
      // Act
      const res = await request(app).post("/users/logout").send({ refreshToken: "un-token" });

      // Assert
      expect(res.body).toEqual({ success: true });
      expect(mockFakeDb.col("refreshTokens").deleteOne).toHaveBeenCalledWith({
        token: hashToken("un-token"),
      });
    });

    it("should still succeed when the revocation fails", async () => {
      // Arrange
      mockFakeDb.col("refreshTokens").deleteOne.mockRejectedValue(new Error("mongo down"));

      // Act
      const res = await request(app).post("/users/logout").send({ refreshToken: "un-token" });

      // Assert
      expect(res.body).toEqual({ success: true });
    });
  });
});
