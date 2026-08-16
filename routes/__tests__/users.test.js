const request = require("supertest");
const bcrypt = require("bcrypt");
const { ObjectId } = require("mongodb");
const { createFakeDb, mockFind } = require("../../__tests__/helpers/fakeDb");
const { createApp, silenceConsole } = require("../../__tests__/helpers/routerApp");

const USER_ID = "507f1f77bcf86cd799439011";
const CURRENT_PASSWORD = "Courant1!";

// Préfixe `mock` obligatoire : la factory de jest.mock est hoistée au-dessus des require.
const mockFakeDb = createFakeDb();
let mockCurrentUser = { _id: new ObjectId(USER_ID) };

jest.mock("../../db", () => ({ getDb: () => mockFakeDb.db }));

jest.mock("../../middleware/auth", () => ({
  requireAuth: (req, _res, next) => {
    req.user = mockCurrentUser;
    next();
  },
}));

jest.mock("../../middleware/rateLimiter", () => ({
  authLimiter: (_req, _res, next) => next(),
  generalLimiter: (_req, _res, next) => next(),
  searchLimiter: (_req, _res, next) => next(),
  iapLimiter: (_req, _res, next) => next(),
}));

jest.mock("../friends", () => ({ linkPendingFriendRequests: jest.fn() }));
jest.mock("../../utils/email", () => ({ sendDataExportEmail: jest.fn() }));

const { linkPendingFriendRequests } = require("../friends");
const { sendDataExportEmail } = require("../../utils/email");
const { encrypt, hashField } = require("../../utils/crypto");
const usersRouter = require("../users");

const premiumSubscription = () => ({
  status: "active",
  endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
});

describe("users router", () => {
  let app;
  let restoreConsole;
  let currentPasswordHash;

  beforeAll(async () => {
    app = createApp("/users", usersRouter);
    restoreConsole = silenceConsole();
    currentPasswordHash = await bcrypt.hash(CURRENT_PASSWORD, 10);
  });

  afterAll(() => restoreConsole());

  beforeEach(() => {
    mockFakeDb.reset();
    jest.clearAllMocks();
    mockCurrentUser = { _id: new ObjectId(USER_ID) };
  });

  describe("PUT /users/me", () => {
    it("should return 400 when the name or the email is missing", async () => {
      // Act
      const res = await request(app).put("/users/me").send({ name: "Alice" });

      // Assert
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ success: false, error: "Nom et email requis" });
    });

    it("should return 409 when the email is already used by someone else", async () => {
      // Arrange
      mockFakeDb.col("users").findOne.mockResolvedValue({ _id: new ObjectId() });

      // Act
      const res = await request(app)
        .put("/users/me")
        .send({ name: "Alice", email: "alice@test.com" });

      // Assert
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("Email déjà utilisé");
    });

    it("should encrypt the profile fields and store the email hash", async () => {
      // Arrange
      mockFakeDb.col("users").findOne.mockResolvedValue(null);

      // Act
      await request(app).put("/users/me").send({ name: " Alice ", email: "ALICE@test.com" });

      // Assert
      const [, update] = mockFakeDb.col("users").updateOne.mock.calls[0];
      expect(update.$set.emailHash).toBe(hashField("alice@test.com"));
      expect(update.$set.name).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
    });

    it("should reset the phone fields to null when the phone is emptied", async () => {
      // Arrange
      mockFakeDb.col("users").findOne.mockResolvedValue(null);

      // Act
      await request(app)
        .put("/users/me")
        .send({ name: "Alice", email: "alice@test.com", phone: "" });

      // Assert
      const [, update] = mockFakeDb.col("users").updateOne.mock.calls[0];
      expect(update.$set).toMatchObject({ phone: null, phoneHash: null });
    });

    it("should persist a supported language only", async () => {
      // Arrange
      mockFakeDb.col("users").findOne.mockResolvedValue(null);

      // Act
      await request(app)
        .put("/users/me")
        .send({ name: "Alice", email: "alice@test.com", language: "de" });

      // Assert
      const [, update] = mockFakeDb.col("users").updateOne.mock.calls[0];
      expect(update.$set.language).toBeUndefined();
    });

    it("should link the pending friend requests to the updated identity", async () => {
      // Arrange
      mockFakeDb.col("users").findOne.mockResolvedValue(null);

      // Act
      await request(app)
        .put("/users/me")
        .send({ name: "Alice", email: "alice@test.com", phone: "+33612345678" });

      // Assert
      expect(linkPendingFriendRequests).toHaveBeenCalledWith(
        USER_ID,
        "alice@test.com",
        "+33612345678"
      );
    });

    it("should return 500 when the update fails", async () => {
      // Arrange
      mockFakeDb.col("users").findOne.mockResolvedValue(null);
      mockFakeDb.col("users").updateOne.mockRejectedValue(new Error("mongo down"));

      // Act
      const res = await request(app)
        .put("/users/me")
        .send({ name: "Alice", email: "alice@test.com" });

      // Assert
      expect(res.status).toBe(500);
    });
  });

  describe("PUT /users/avatar", () => {
    it("should return 400 when the avatar is not a string", async () => {
      // Act
      const res = await request(app).put("/users/avatar").send({ avatar: 42 });

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Avatar requis");
    });

    it("should reject a data URL whose MIME type is not an allowed image", async () => {
      // Act
      const res = await request(app)
        .put("/users/avatar")
        .send({ avatar: "data:text/html;base64,PHNjcmlwdD4=" });

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Format d'avatar invalide");
    });

    it("should reject a data URL heavier than 5 MB", async () => {
      // Act
      const res = await request(app)
        .put("/users/avatar")
        .send({ avatar: `data:image/png;base64,${"A".repeat(5 * 1024 * 1024)}` });

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Avatar trop volumineux (5 Mo max)");
    });

    it("should reject a remote avatar served over plain HTTP", async () => {
      // Act
      const res = await request(app)
        .put("/users/avatar")
        .send({ avatar: "http://cdn.test/avatar.png" });

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("URL d'avatar invalide (HTTPS requis)");
    });

    it("should reject a malformed avatar URL", async () => {
      // Act
      const res = await request(app).put("/users/avatar").send({ avatar: "pas-une-url" });

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Format d'avatar invalide");
    });

    it("should propagate the new avatar to the friend documents", async () => {
      // Arrange
      const avatar = "https://cdn.test/avatar.png";

      // Act
      const res = await request(app).put("/users/avatar").send({ avatar });

      // Assert
      expect(res.body.success).toBe(true);
      expect(mockFakeDb.col("friends").updateMany).toHaveBeenCalledWith(
        { friendId: USER_ID },
        { $set: { avatar } }
      );
    });

    it("should return 500 when the update fails", async () => {
      // Arrange
      mockFakeDb.col("users").updateOne.mockRejectedValue(new Error("mongo down"));

      // Act
      const res = await request(app)
        .put("/users/avatar")
        .send({ avatar: "https://cdn.test/avatar.png" });

      // Assert
      expect(res.status).toBe(500);
    });
  });

  describe("PUT /users/settings", () => {
    it("should return 400 when isPublicProfile is not a boolean", async () => {
      // Act
      const res = await request(app).put("/users/settings").send({ isPublicProfile: "oui" });

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("isPublicProfile doit être un booléen");
    });

    it("should persist the public profile flag", async () => {
      // Act
      const res = await request(app).put("/users/settings").send({ isPublicProfile: true });

      // Assert
      expect(res.body.success).toBe(true);
      const [, update] = mockFakeDb.col("users").updateOne.mock.calls[0];
      expect(update.$set.isPublicProfile).toBe(true);
    });

    it("should return 500 when the update fails", async () => {
      // Arrange
      mockFakeDb.col("users").updateOne.mockRejectedValue(new Error("mongo down"));

      // Act
      const res = await request(app).put("/users/settings").send({ isPublicProfile: false });

      // Assert
      expect(res.status).toBe(500);
    });
  });

  describe("PUT /users/language", () => {
    it("should return 400 when the language is not supported", async () => {
      // Act
      const res = await request(app).put("/users/language").send({ language: "de" });

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Langue invalide. Valeurs acceptées : en, fr");
    });

    it("should echo the persisted language", async () => {
      // Act
      const res = await request(app).put("/users/language").send({ language: "en" });

      // Assert
      expect(res.body).toEqual({ success: true, language: "en" });
    });

    it("should return 500 when the update fails", async () => {
      // Arrange
      mockFakeDb.col("users").updateOne.mockRejectedValue(new Error("mongo down"));

      // Act
      const res = await request(app).put("/users/language").send({ language: "fr" });

      // Assert
      expect(res.status).toBe(500);
    });
  });

  describe("PUT /users/change-password", () => {
    it("should return 400 when a field is missing", async () => {
      // Act
      const res = await request(app).put("/users/change-password").send({ newPassword: "Abcd1234!" });

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Champs requis manquants");
    });

    it("should return 400 when the current password does not match", async () => {
      // Arrange
      mockCurrentUser = { _id: new ObjectId(USER_ID), password: currentPasswordHash };

      // Act
      const res = await request(app)
        .put("/users/change-password")
        .send({ currentPassword: "Faux1234!", newPassword: "Abcd1234!" });

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Mot de passe actuel incorrect");
    });

    it("should return 400 when the account carries no password hash", async () => {
      // Act
      const res = await request(app)
        .put("/users/change-password")
        .send({ currentPassword: CURRENT_PASSWORD, newPassword: "Abcd1234!" });

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Mot de passe actuel incorrect");
    });

    it("should return 400 when the new password is too weak", async () => {
      // Arrange
      mockCurrentUser = { _id: new ObjectId(USER_ID), passwordHash: currentPasswordHash };

      // Act
      const res = await request(app)
        .put("/users/change-password")
        .send({ currentPassword: CURRENT_PASSWORD, newPassword: "faible" });

      // Assert
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: "Mot de passe trop faible", field: "password" });
    });

    it("should drop the legacy passwordHash field when the password is rotated", async () => {
      // Arrange
      mockCurrentUser = { _id: new ObjectId(USER_ID), passwordHash: currentPasswordHash };

      // Act
      const res = await request(app)
        .put("/users/change-password")
        .send({ currentPassword: CURRENT_PASSWORD, newPassword: "Abcd1234!" });

      // Assert
      expect(res.body).toEqual({ success: true });
      const [, update] = mockFakeDb.col("users").updateOne.mock.calls[0];
      expect(update.$unset).toEqual({ passwordHash: "" });
    });
  });

  describe("DELETE /users/me", () => {
    it("should not reschedule a deletion that is already pending", async () => {
      // Arrange
      const scheduledAt = new Date("2026-07-01T00:00:00.000Z");
      mockCurrentUser = {
        _id: new ObjectId(USER_ID),
        pendingDeletion: true,
        deletionScheduledAt: scheduledAt,
      };

      // Act
      const res = await request(app).delete("/users/me");

      // Assert
      expect(res.body.alreadyPending).toBe(true);
      expect(mockFakeDb.col("users").updateOne).not.toHaveBeenCalled();
    });

    it("should revoke the refresh tokens when scheduling the deletion", async () => {
      // Act
      const res = await request(app).delete("/users/me");

      // Assert
      expect(res.body.success).toBe(true);
      expect(mockFakeDb.col("refreshTokens").deleteMany).toHaveBeenCalledWith({ userId: USER_ID });
    });

    it("should email the personal data export to the account owner", async () => {
      // Arrange
      mockFakeDb.col("users").findOne.mockResolvedValue({
        _id: new ObjectId(USER_ID),
        name: encrypt("Alice"),
        email: encrypt("alice@test.com"),
      });
      mockFind(mockFakeDb.col("trips"), [{ _id: new ObjectId(), destination: "Rome" }]);

      // Act
      await request(app).delete("/users/me");

      // Assert
      expect(sendDataExportEmail).toHaveBeenCalledWith(
        "alice@test.com",
        expect.objectContaining({ profile: expect.objectContaining({ name: "Alice" }) })
      );
    });

    it("should still succeed when the export email cannot be sent", async () => {
      // Arrange
      mockFakeDb.col("users").findOne.mockResolvedValue({ _id: new ObjectId(USER_ID) });
      sendDataExportEmail.mockRejectedValue(new Error("SMTP indisponible"));

      // Act
      const res = await request(app).delete("/users/me");

      // Assert
      expect(res.body.success).toBe(true);
    });

    it("should return 500 when the scheduling itself fails", async () => {
      // Arrange
      mockFakeDb.col("users").updateOne.mockRejectedValue(new Error("mongo down"));

      // Act
      const res = await request(app).delete("/users/me");

      // Assert
      expect(res.status).toBe(500);
    });
  });

  describe("POST /users/me/cancel-deletion", () => {
    it("should return 400 when no deletion is scheduled", async () => {
      // Act
      const res = await request(app).post("/users/me/cancel-deletion");

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Aucune suppression planifiée");
    });

    it("should unset the deletion markers when one is pending", async () => {
      // Arrange
      mockCurrentUser = { _id: new ObjectId(USER_ID), pendingDeletion: true };

      // Act
      const res = await request(app).post("/users/me/cancel-deletion");

      // Assert
      expect(res.body).toEqual({ success: true });
      const [, update] = mockFakeDb.col("users").updateOne.mock.calls[0];
      expect(update.$unset).toEqual({ pendingDeletion: "", deletionScheduledAt: "" });
    });

    it("should return 500 when the update fails", async () => {
      // Arrange
      mockCurrentUser = { _id: new ObjectId(USER_ID), pendingDeletion: true };
      mockFakeDb.col("users").updateOne.mockRejectedValue(new Error("mongo down"));

      // Act
      const res = await request(app).post("/users/me/cancel-deletion");

      // Assert
      expect(res.status).toBe(500);
    });
  });

  describe("POST /users/batch", () => {
    it("should return 400 when the id list is empty", async () => {
      // Act
      const res = await request(app).post("/users/batch").send({ ids: [] });

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Tableau d'IDs requis (1 à 100)");
    });

    it("should return 400 when more than 100 ids are requested", async () => {
      // Act
      const res = await request(app)
        .post("/users/batch")
        .send({ ids: Array.from({ length: 101 }, () => USER_ID) });

      // Assert
      expect(res.status).toBe(400);
    });

    it("should ignore malformed ids instead of failing", async () => {
      // Arrange
      mockFind(mockFakeDb.col("users"), []);

      // Act
      const res = await request(app).post("/users/batch").send({ ids: [USER_ID, "pas-un-id"] });

      // Assert
      expect(res.status).toBe(200);
      const [filter] = mockFakeDb.col("users").find.mock.calls[0];
      expect(filter._id.$in).toHaveLength(1);
    });

    it("should decrypt the name and the email of each user", async () => {
      // Arrange
      mockFind(mockFakeDb.col("users"), [
        { _id: new ObjectId(USER_ID), name: encrypt("Alice"), email: encrypt("alice@test.com") },
      ]);

      // Act
      const res = await request(app).post("/users/batch").send({ ids: [USER_ID] });

      // Assert
      expect(res.body[0]).toMatchObject({ id: USER_ID, name: "Alice", email: "alice@test.com" });
    });

    it("should return 500 when the lookup fails", async () => {
      // Arrange
      mockFakeDb.col("users").find.mockImplementation(() => {
        throw new Error("mongo down");
      });

      // Act
      const res = await request(app).post("/users/batch").send({ ids: [USER_ID] });

      // Assert
      expect(res.status).toBe(500);
    });
  });

  describe("GET /users/lookup", () => {
    it("should return 400 when neither email nor phone is provided", async () => {
      // Act
      const res = await request(app).get("/users/lookup");

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("email ou phone requis");
    });

    it("should return 400 when the email format is invalid", async () => {
      // Act
      const res = await request(app).get("/users/lookup?email=pas-un-email");

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Format d'email invalide");
    });

    it("should return 400 when the phone format is invalid", async () => {
      // Act
      const res = await request(app).get("/users/lookup?phone=abc");

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Format de téléphone invalide");
    });

    it("should return 404 when no user matches", async () => {
      // Arrange
      mockFakeDb.col("users").findOne.mockResolvedValue(null);

      // Act
      const res = await request(app).get("/users/lookup?email=bob@test.com");

      // Assert
      expect(res.status).toBe(404);
    });

    it("should return 400 when the user looks up his own account", async () => {
      // Arrange
      mockFakeDb.col("users").findOne.mockResolvedValue({ _id: new ObjectId(USER_ID) });

      // Act
      const res = await request(app).get("/users/lookup?email=alice@test.com");

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Impossible de s'ajouter soi-même");
    });

    it("should report a friend relation when a friendship document exists", async () => {
      // Arrange
      const foundId = new ObjectId();
      mockFakeDb.col("users").findOne.mockResolvedValue({ _id: foundId, name: encrypt("Bob") });
      mockFakeDb.col("friends").findOne.mockResolvedValue({ userId: USER_ID });

      // Act
      const res = await request(app).get("/users/lookup?email=bob@test.com");

      // Assert
      expect(res.body).toMatchObject({ id: String(foundId), name: "Bob", relation: "friend" });
    });

    it("should report a pending_sent relation when the user already sent a request", async () => {
      // Arrange
      mockFakeDb.col("users").findOne.mockResolvedValue({ _id: new ObjectId() });
      mockFakeDb.col("friendRequests").findOne.mockResolvedValueOnce({ senderId: USER_ID });

      // Act
      const res = await request(app).get("/users/lookup?email=bob@test.com");

      // Assert
      expect(res.body.relation).toBe("pending_sent");
    });

    it("should report a pending_received relation when the other user sent a request", async () => {
      // Arrange
      mockFakeDb.col("users").findOne.mockResolvedValue({ _id: new ObjectId() });
      mockFakeDb.col("friendRequests").findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ recipientId: USER_ID });

      // Act
      const res = await request(app).get("/users/lookup?email=bob@test.com");

      // Assert
      expect(res.body.relation).toBe("pending_received");
    });

    it("should count the distinct destinations as visited countries", async () => {
      // Arrange
      mockFakeDb.col("users").findOne.mockResolvedValue({ _id: new ObjectId() });
      mockFind(mockFakeDb.col("trips"), [
        { destination: "Italie" },
        { destination: "Italie" },
        { destination: "Japon" },
        {},
      ]);

      // Act
      const res = await request(app).get("/users/lookup?phone=%2B33612345678");

      // Assert
      expect(res.body.stats.countries).toBe(2);
      expect(res.body.relation).toBe("none");
    });

    it("should return 500 when the lookup fails", async () => {
      // Arrange
      mockFakeDb.col("users").findOne.mockRejectedValue(new Error("mongo down"));

      // Act
      const res = await request(app).get("/users/lookup?email=bob@test.com");

      // Assert
      expect(res.status).toBe(500);
    });
  });

  describe("GET /users/me/export", () => {
    it("should serve the export as a downloadable JSON attachment", async () => {
      // Arrange
      mockFakeDb.col("users").findOne.mockResolvedValue({
        _id: new ObjectId(USER_ID),
        name: encrypt("Alice"),
        email: encrypt("alice@test.com"),
      });

      // Act
      const res = await request(app).get("/users/me/export");

      // Assert
      expect(res.headers["content-disposition"]).toBe(
        "attachment; filename=mytripcircle-export.json"
      );
      expect(res.body.profile).toMatchObject({ name: "Alice", language: "fr" });
    });

    it("should return 500 when a collection cannot be read", async () => {
      // Arrange
      mockFakeDb.col("users").findOne.mockRejectedValue(new Error("mongo down"));

      // Act
      const res = await request(app).get("/users/me/export");

      // Assert
      expect(res.status).toBe(500);
    });
  });

  describe("calendar token endpoints", () => {
    it("should return 403 on GET when the user has no premium subscription", async () => {
      // Arrange
      mockFakeDb.col("subscriptions").findOne.mockResolvedValue(null);

      // Act
      const res = await request(app).get("/users/calendar/token");

      // Assert
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("Abonnement premium requis");
    });

    it("should return the stored token on GET for a premium user", async () => {
      // Arrange
      mockFakeDb.col("subscriptions").findOne.mockResolvedValue(premiumSubscription());
      mockFakeDb.col("users").findOne.mockResolvedValue({ calendarToken: "a".repeat(64) });

      // Act
      const res = await request(app).get("/users/calendar/token");

      // Assert
      expect(res.body).toEqual({ success: true, token: "a".repeat(64) });
    });

    it("should return 500 on GET when the lookup fails", async () => {
      // Arrange
      mockFakeDb.col("subscriptions").findOne.mockRejectedValue(new Error("mongo down"));

      // Act
      const res = await request(app).get("/users/calendar/token");

      // Assert
      expect(res.status).toBe(500);
    });

    it("should return 403 on POST when the subscription has expired", async () => {
      // Arrange
      mockFakeDb.col("subscriptions").findOne.mockResolvedValue({
        status: "active",
        endDate: new Date(Date.now() - 1000),
      });

      // Act
      const res = await request(app).post("/users/calendar/token");

      // Assert
      expect(res.status).toBe(403);
    });

    it("should generate a 64-character hexadecimal token on POST", async () => {
      // Arrange
      mockFakeDb.col("subscriptions").findOne.mockResolvedValue(premiumSubscription());

      // Act
      const res = await request(app).post("/users/calendar/token");

      // Assert
      expect(res.body.token).toMatch(/^[0-9a-f]{64}$/);
    });

    it("should return 500 on POST when the update fails", async () => {
      // Arrange
      mockFakeDb.col("subscriptions").findOne.mockResolvedValue(premiumSubscription());
      mockFakeDb.col("users").updateOne.mockRejectedValue(new Error("mongo down"));

      // Act
      const res = await request(app).post("/users/calendar/token");

      // Assert
      expect(res.status).toBe(500);
    });

    it("should unset the token on DELETE", async () => {
      // Act
      const res = await request(app).delete("/users/calendar/token");

      // Assert
      expect(res.body).toEqual({ success: true });
      const [, update] = mockFakeDb.col("users").updateOne.mock.calls[0];
      expect(update.$unset).toEqual({ calendarToken: "" });
    });

    it("should return 500 on DELETE when the update fails", async () => {
      // Arrange
      mockFakeDb.col("users").updateOne.mockRejectedValue(new Error("mongo down"));

      // Act
      const res = await request(app).delete("/users/calendar/token");

      // Assert
      expect(res.status).toBe(500);
    });
  });

  describe("POST /users/push-token", () => {
    it("should return 400 when the token is not an Expo push token", async () => {
      // Act
      const res = await request(app).post("/users/push-token").send({ token: "abc" });

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Token invalide");
    });

    it("should default the platform to expo when it is omitted", async () => {
      // Act
      const res = await request(app)
        .post("/users/push-token")
        .send({ token: "ExponentPushToken[xxx]" });

      // Assert
      expect(res.body).toEqual({ success: true });
      const [, update] = mockFakeDb.col("users").updateOne.mock.calls[0];
      expect(update.$set.pushPlatform).toBe("expo");
    });

    it("should return 500 when the update fails", async () => {
      // Arrange
      mockFakeDb.col("users").updateOne.mockRejectedValue(new Error("mongo down"));

      // Act
      const res = await request(app)
        .post("/users/push-token")
        .send({ token: "ExponentPushToken[xxx]", platform: "ios" });

      // Assert
      expect(res.status).toBe(500);
    });
  });

  describe("POST /users/consent", () => {
    it("should store the optional consents as false when they are not explicitly granted", async () => {
      // Act
      const res = await request(app).post("/users/consent").send({ location: "oui" });

      // Assert
      expect(res.body).toEqual({ success: true });
      const [inserted] = mockFakeDb.col("user_consents").insertOne.mock.calls[0];
      expect(inserted.consents).toEqual({ data: true, location: false, notifications: false });
    });

    it("should fall back to the default consent version when none is provided", async () => {
      // Act
      await request(app).post("/users/consent").send({ location: true, notifications: true });

      // Assert
      const [inserted] = mockFakeDb.col("user_consents").insertOne.mock.calls[0];
      expect(inserted.version).toBe("1.0");
    });

    it("should return 500 when the insertion fails", async () => {
      // Arrange
      mockFakeDb.col("user_consents").insertOne.mockRejectedValue(new Error("mongo down"));

      // Act
      const res = await request(app).post("/users/consent").send({});

      // Assert
      expect(res.status).toBe(500);
    });
  });
});
