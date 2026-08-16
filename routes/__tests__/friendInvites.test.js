const request = require("supertest");
const { ObjectId } = require("mongodb");
const { createFakeDb } = require("../../__tests__/helpers/fakeDb");
const { createApp, silenceConsole } = require("../../__tests__/helpers/routerApp");

const USER_ID = "507f1f77bcf86cd799439011";
const OWNER_ID = "507f1f77bcf86cd799439022";
const TOKEN = "a".repeat(64);

// Préfixe `mock` obligatoire : la factory de jest.mock est hoistée au-dessus des require.
const mockFakeDb = createFakeDb();
jest.mock("../../db", () => ({ getDb: () => mockFakeDb.db }));

jest.mock("../../middleware/auth", () => ({
  requireAuth: (req, _res, next) => {
    req.user = {
      _id: "507f1f77bcf86cd799439011",
      name: "Alice",
      email: "alice@test.com",
      phone: null,
    };
    next();
  },
}));

jest.mock("../../utils/email", () => ({ sendFriendJoinedEmail: jest.fn() }));

const { sendFriendJoinedEmail } = require("../../utils/email");
const { encrypt } = require("../../utils/crypto");
const friendInvitesRouter = require("../friendInvites");

const FUTURE = () => new Date(Date.now() + 24 * 60 * 60 * 1000);
const PAST = () => new Date(Date.now() - 1000);

describe("friendInvites router", () => {
  let app;
  let restoreConsole;

  beforeAll(() => {
    app = createApp("/friends", friendInvitesRouter);
    restoreConsole = silenceConsole();
  });

  afterAll(() => restoreConsole());

  beforeEach(() => {
    mockFakeDb.reset();
    jest.clearAllMocks();
  });

  describe("POST /friends/invite-link", () => {
    it("should reuse the existing link when it has not expired", async () => {
      // Arrange
      mockFakeDb.col("friendInviteLinks").findOne.mockResolvedValue({
        _id: "link-1",
        token: TOKEN,
        expiresAt: FUTURE(),
      });

      // Act
      const res = await request(app).post("/friends/invite-link");

      // Assert
      expect(res.body).toEqual({ token: TOKEN, link: `mytripcircle://friend-invite/${TOKEN}` });
      expect(mockFakeDb.col("friendInviteLinks").insertOne).not.toHaveBeenCalled();
    });

    it("should replace an expired link by a freshly generated one", async () => {
      // Arrange
      mockFakeDb.col("friendInviteLinks").findOne.mockResolvedValue({
        _id: "link-1",
        token: TOKEN,
        expiresAt: PAST(),
      });

      // Act
      const res = await request(app).post("/friends/invite-link");

      // Assert
      expect(mockFakeDb.col("friendInviteLinks").deleteOne).toHaveBeenCalledWith({ _id: "link-1" });
      expect(res.body.token).toMatch(/^[0-9a-f]{64}$/);
      expect(res.body.token).not.toBe(TOKEN);
    });

    it("should create a link when the user has none", async () => {
      // Arrange
      mockFakeDb.col("friendInviteLinks").findOne.mockResolvedValue(null);

      // Act
      const res = await request(app).post("/friends/invite-link");

      // Assert
      expect(res.body.link).toBe(`mytripcircle://friend-invite/${res.body.token}`);
      const [inserted] = mockFakeDb.col("friendInviteLinks").insertOne.mock.calls[0];
      expect(inserted.userId).toBe(USER_ID);
    });

    it("should return 500 when the database fails", async () => {
      // Arrange
      mockFakeDb.col("friendInviteLinks").findOne.mockRejectedValue(new Error("mongo down"));

      // Act
      const res = await request(app).post("/friends/invite-link");

      // Assert
      expect(res.status).toBe(500);
    });
  });

  describe("GET /friends/invite-link/:token", () => {
    it("should return 404 when the link does not exist", async () => {
      // Arrange
      mockFakeDb.col("friendInviteLinks").findOne.mockResolvedValue(null);

      // Act
      const res = await request(app).get(`/friends/invite-link/${TOKEN}`);

      // Assert
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Lien introuvable");
    });

    it("should return 400 when the link has expired", async () => {
      // Arrange
      mockFakeDb.col("friendInviteLinks").findOne.mockResolvedValue({ expiresAt: PAST() });

      // Act
      const res = await request(app).get(`/friends/invite-link/${TOKEN}`);

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Lien d'invitation expiré");
    });

    it("should return 404 when the link owner no longer exists", async () => {
      // Arrange
      mockFakeDb.col("friendInviteLinks").findOne.mockResolvedValue({
        userId: OWNER_ID,
        expiresAt: FUTURE(),
      });
      mockFakeDb.col("users").findOne.mockResolvedValue(null);

      // Act
      const res = await request(app).get(`/friends/invite-link/${TOKEN}`);

      // Assert
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Utilisateur introuvable");
    });

    it("should expose the decrypted owner identity", async () => {
      // Arrange
      mockFakeDb.col("friendInviteLinks").findOne.mockResolvedValue({
        userId: OWNER_ID,
        expiresAt: FUTURE(),
      });
      mockFakeDb.col("users").findOne.mockResolvedValue({
        _id: new ObjectId(OWNER_ID),
        name: encrypt("Bob"),
        avatar: "https://cdn.test/bob.png",
      });

      // Act
      const res = await request(app).get(`/friends/invite-link/${TOKEN}`);

      // Assert
      expect(res.body).toEqual({
        userId: OWNER_ID,
        name: "Bob",
        avatar: "https://cdn.test/bob.png",
      });
    });

    it("should return 500 when the database fails", async () => {
      // Arrange
      mockFakeDb.col("friendInviteLinks").findOne.mockRejectedValue(new Error("mongo down"));

      // Act
      const res = await request(app).get(`/friends/invite-link/${TOKEN}`);

      // Assert
      expect(res.status).toBe(500);
    });
  });

  describe("POST /friends/invite-link/:token/accept", () => {
    const ownerDoc = () => ({
      _id: new ObjectId(OWNER_ID),
      name: encrypt("Bob"),
      email: encrypt("bob@test.com"),
      phone: null,
      avatar: null,
    });

    it("should return 404 when the link does not exist", async () => {
      // Arrange
      mockFakeDb.col("friendInviteLinks").findOne.mockResolvedValue(null);

      // Act
      const res = await request(app).post(`/friends/invite-link/${TOKEN}/accept`);

      // Assert
      expect(res.status).toBe(404);
    });

    it("should return 400 when the link has expired", async () => {
      // Arrange
      mockFakeDb.col("friendInviteLinks").findOne.mockResolvedValue({ expiresAt: PAST() });

      // Act
      const res = await request(app).post(`/friends/invite-link/${TOKEN}/accept`);

      // Assert
      expect(res.status).toBe(400);
    });

    it("should return 400 when the user opens his own link", async () => {
      // Arrange
      mockFakeDb.col("friendInviteLinks").findOne.mockResolvedValue({
        userId: USER_ID,
        expiresAt: FUTURE(),
      });

      // Act
      const res = await request(app).post(`/friends/invite-link/${TOKEN}/accept`);

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Impossible de s'ajouter soi-même");
    });

    it("should return 400 when both users are already friends", async () => {
      // Arrange
      mockFakeDb.col("friendInviteLinks").findOne.mockResolvedValue({
        userId: OWNER_ID,
        expiresAt: FUTURE(),
      });
      mockFakeDb.col("friends").findOne.mockResolvedValue({ userId: USER_ID });

      // Act
      const res = await request(app).post(`/friends/invite-link/${TOKEN}/accept`);

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Déjà amis");
    });

    it("should return 404 when the link owner no longer exists", async () => {
      // Arrange
      mockFakeDb.col("friendInviteLinks").findOne.mockResolvedValue({
        userId: OWNER_ID,
        expiresAt: FUTURE(),
      });
      mockFakeDb.col("friends").findOne.mockResolvedValue(null);
      mockFakeDb.col("users").findOne.mockResolvedValue(null);

      // Act
      const res = await request(app).post(`/friends/invite-link/${TOKEN}/accept`);

      // Assert
      expect(res.status).toBe(404);
    });

    it("should accept the pending request instead of creating a new one", async () => {
      // Arrange
      mockFakeDb.col("friendInviteLinks").findOne.mockResolvedValue({
        userId: OWNER_ID,
        expiresAt: FUTURE(),
      });
      mockFakeDb.col("friends").findOne.mockResolvedValue(null);
      mockFakeDb.col("users").findOne.mockResolvedValue(ownerDoc());
      mockFakeDb.col("friendRequests").findOne.mockResolvedValue({ _id: "req-1" });

      // Act
      const res = await request(app).post(`/friends/invite-link/${TOKEN}/accept`);

      // Assert
      expect(res.body).toEqual({ success: true });
      expect(mockFakeDb.col("friendRequests").insertOne).not.toHaveBeenCalled();
      expect(mockFakeDb.col("friendRequests").updateOne).toHaveBeenCalledWith(
        { _id: "req-1" },
        { $set: expect.objectContaining({ status: "accepted" }) }
      );
    });

    it("should create both friendships and notify the link owner", async () => {
      // Arrange
      mockFakeDb.col("friendInviteLinks").findOne.mockResolvedValue({
        userId: OWNER_ID,
        expiresAt: FUTURE(),
      });
      mockFakeDb.col("friends").findOne.mockResolvedValue(null);
      mockFakeDb.col("users").findOne.mockResolvedValue(ownerDoc());
      mockFakeDb.col("friendRequests").findOne.mockResolvedValue(null);

      // Act
      const res = await request(app).post(`/friends/invite-link/${TOKEN}/accept`);

      // Assert
      expect(res.body).toEqual({ success: true });
      const [docs] = mockFakeDb.col("friends").insertMany.mock.calls[0];
      expect(docs).toHaveLength(2);
      expect(docs[1].name).not.toBe("Alice");
      expect(sendFriendJoinedEmail).toHaveBeenCalledWith("bob@test.com", "Alice");
    });

    it("should return 500 when the database fails", async () => {
      // Arrange
      mockFakeDb.col("friendInviteLinks").findOne.mockRejectedValue(new Error("mongo down"));

      // Act
      const res = await request(app).post(`/friends/invite-link/${TOKEN}/accept`);

      // Assert
      expect(res.status).toBe(500);
    });
  });
});
