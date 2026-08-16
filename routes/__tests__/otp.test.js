const request = require("supertest");
const { ObjectId } = require("mongodb");
const { createFakeDb } = require("../../__tests__/helpers/fakeDb");
const { createApp, silenceConsole } = require("../../__tests__/helpers/routerApp");

const USER_ID = "507f1f77bcf86cd799439011";

// Préfixe `mock` obligatoire : la factory de jest.mock est hoistée au-dessus des require.
const mockFakeDb = createFakeDb();
jest.mock("../../db", () => ({ getDb: () => mockFakeDb.db }));

jest.mock("../../middleware/rateLimiter", () => ({
  authLimiter: (_req, _res, next) => next(),
  generalLimiter: (_req, _res, next) => next(),
  searchLimiter: (_req, _res, next) => next(),
  iapLimiter: (_req, _res, next) => next(),
}));

jest.mock("../../utils/email", () => ({ sendPasswordResetEmail: jest.fn() }));

const { sendPasswordResetEmail } = require("../../utils/email");
const otpRouter = require("../otp");

describe("otp router", () => {
  let app;
  let restoreConsole;

  beforeAll(() => {
    app = createApp("/users", otpRouter);
    restoreConsole = silenceConsole();
  });

  afterAll(() => restoreConsole());

  beforeEach(() => {
    mockFakeDb.reset();
    jest.clearAllMocks();
  });

  describe("POST /users/forgot-password", () => {
    it("should return 400 when the email is missing", async () => {
      // Act
      const res = await request(app).post("/users/forgot-password").send({});

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Email requis");
    });

    it("should answer the same message when no account matches, without sending an email", async () => {
      // Arrange
      mockFakeDb.col("users").findOne.mockResolvedValue(null);

      // Act
      const res = await request(app)
        .post("/users/forgot-password")
        .send({ email: "inconnu@test.com" });

      // Assert
      expect(res.body).toEqual({
        success: true,
        message: "Si un compte existe, un lien a été envoyé",
      });
      expect(sendPasswordResetEmail).not.toHaveBeenCalled();
    });

    it("should store a reset token and email it when the account exists", async () => {
      // Arrange
      mockFakeDb.col("users").findOne.mockResolvedValue({ _id: new ObjectId(USER_ID) });

      // Act
      const res = await request(app)
        .post("/users/forgot-password")
        .send({ email: "Alice@test.com" });

      // Assert
      expect(res.body.success).toBe(true);
      const [, update] = mockFakeDb.col("users").updateOne.mock.calls[0];
      expect(update.$set.resetToken).toMatch(/^[0-9a-f]{64}$/);
      expect(sendPasswordResetEmail).toHaveBeenCalledWith(
        "alice@test.com",
        update.$set.resetToken
      );
    });

    it("should return 500 when the database fails", async () => {
      // Arrange
      mockFakeDb.col("users").findOne.mockRejectedValue(new Error("mongo down"));

      // Act
      const res = await request(app)
        .post("/users/forgot-password")
        .send({ email: "alice@test.com" });

      // Assert
      expect(res.status).toBe(500);
    });
  });

  describe("GET /users/verify-reset-token", () => {
    it("should return 400 when the code is missing", async () => {
      // Act
      const res = await request(app).get("/users/verify-reset-token");

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Code manquant");
    });

    it("should return 400 when no account matches the code", async () => {
      // Arrange
      mockFakeDb.col("users").findOne.mockResolvedValue(null);

      // Act
      const res = await request(app).get("/users/verify-reset-token?code=abc");

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Lien invalide ou déjà utilisé");
    });

    it("should confirm a code that is still valid", async () => {
      // Arrange
      mockFakeDb.col("users").findOne.mockResolvedValue({ _id: new ObjectId(USER_ID) });

      // Act
      const res = await request(app).get("/users/verify-reset-token?code=abc");

      // Assert
      expect(res.body).toEqual({ success: true });
    });

    it("should return 500 when the database fails", async () => {
      // Arrange
      mockFakeDb.col("users").findOne.mockRejectedValue(new Error("mongo down"));

      // Act
      const res = await request(app).get("/users/verify-reset-token?code=abc");

      // Assert
      expect(res.status).toBe(500);
    });
  });

  describe("POST /users/reset-password", () => {
    it("should return 400 when the code or the password is missing", async () => {
      // Act
      const res = await request(app).post("/users/reset-password").send({ code: "abc" });

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Code et nouveau mot de passe requis");
    });

    it("should return 400 when the new password is too weak", async () => {
      // Act
      const res = await request(app)
        .post("/users/reset-password")
        .send({ code: "abc", newPassword: "faible" });

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.field).toBe("password");
    });

    it("should return 400 when the code is unknown or expired", async () => {
      // Arrange
      mockFakeDb.col("users").findOne.mockResolvedValue(null);

      // Act
      const res = await request(app)
        .post("/users/reset-password")
        .send({ code: "abc", newPassword: "Abcd1234!" });

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Code invalide ou expiré");
    });

    it("should replace the password and clear the reset markers", async () => {
      // Arrange
      mockFakeDb.col("users").findOne.mockResolvedValue({ _id: new ObjectId(USER_ID) });

      // Act
      const res = await request(app)
        .post("/users/reset-password")
        .send({ code: "abc", newPassword: "Abcd1234!" });

      // Assert
      expect(res.body.success).toBe(true);
      expect(res.body.token).toBeDefined();
      const [, update] = mockFakeDb.col("users").updateOne.mock.calls[0];
      expect(update.$unset).toEqual({ resetCode: "", resetCodeExpiresAt: "", passwordHash: "" });
      expect(update.$set.password).not.toBe("Abcd1234!");
    });

    it("should return 500 when the database fails", async () => {
      // Arrange
      mockFakeDb.col("users").findOne.mockRejectedValue(new Error("mongo down"));

      // Act
      const res = await request(app)
        .post("/users/reset-password")
        .send({ code: "abc", newPassword: "Abcd1234!" });

      // Assert
      expect(res.status).toBe(500);
    });
  });

  describe("GET /users/reset-password-page", () => {
    it("should return 400 with an error page when the token is missing", async () => {
      // Act
      const res = await request(app).get("/users/reset-password-page");

      // Assert
      expect(res.status).toBe(400);
      expect(res.text).toContain("Token manquant.");
    });

    it("should return 400 with an error page when the token is unknown", async () => {
      // Arrange
      mockFakeDb.col("users").findOne.mockResolvedValue(null);

      // Act
      const res = await request(app).get("/users/reset-password-page?token=abc");

      // Assert
      expect(res.status).toBe(400);
      expect(res.text).toContain("Ce lien est invalide ou a déjà été utilisé.");
    });

    it("should exchange the token for a single-use code carried by the deep link", async () => {
      // Arrange
      mockFakeDb.col("users").findOne.mockResolvedValue({ _id: new ObjectId(USER_ID) });

      // Act
      const res = await request(app).get("/users/reset-password-page?token=abc");

      // Assert
      const [, update] = mockFakeDb.col("users").updateOne.mock.calls[0];
      expect(update.$unset).toEqual({ resetToken: "", resetTokenExpiresAt: "" });
      expect(res.text).toContain(`mytripcircle://reset-password?code=${update.$set.resetCode}`);
    });

    it("should return 500 with an error page when the database fails", async () => {
      // Arrange
      mockFakeDb.col("users").findOne.mockRejectedValue(new Error("mongo down"));

      // Act
      const res = await request(app).get("/users/reset-password-page?token=abc");

      // Assert
      expect(res.status).toBe(500);
      expect(res.text).toContain("Une erreur est survenue. Réessayez.");
    });
  });
});
