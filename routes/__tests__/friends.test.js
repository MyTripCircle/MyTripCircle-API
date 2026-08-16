const request = require("supertest");
const { ObjectId } = require("mongodb");
const { createFakeDb, mockFind } = require("../../__tests__/helpers/fakeDb");
const { createApp, silenceConsole } = require("../../__tests__/helpers/routerApp");

const USER_ID = "507f1f77bcf86cd799439011";
const FRIEND_ID = "507f1f77bcf86cd799439022";
const STRANGER_ID = "507f1f77bcf86cd799439033";

// Préfixe `mock` obligatoire : la factory de jest.mock est hoistée au-dessus des require.
const mockFakeDb = createFakeDb();
jest.mock("../../db", () => ({ getDb: () => mockFakeDb.db }));

jest.mock("../../middleware/auth", () => ({
  requireAuth: (req, _res, next) => {
    req.user = { _id: "507f1f77bcf86cd799439011" };
    next();
  },
}));

jest.mock("../../middleware/rateLimiter", () => ({
  authLimiter: (_req, _res, next) => next(),
  generalLimiter: (_req, _res, next) => next(),
  searchLimiter: (_req, _res, next) => next(),
  iapLimiter: (_req, _res, next) => next(),
}));

jest.mock("../../utils/email", () => ({ sendFriendRequestFoundEmail: jest.fn() }));

const { sendFriendRequestFoundEmail } = require("../../utils/email");
const { encrypt } = require("../../utils/crypto");
const friendsRouter = require("../friends");
const { linkPendingFriendRequests } = require("../friends");

describe("friends router", () => {
  let app;
  let restoreConsole;

  beforeAll(() => {
    app = createApp("/friends", friendsRouter);
    restoreConsole = silenceConsole();
  });

  afterAll(() => restoreConsole());

  beforeEach(() => {
    mockFakeDb.reset();
    jest.clearAllMocks();
  });

  describe("linkPendingFriendRequests", () => {
    it("should return 0 when neither an email nor a phone is known", async () => {
      // Act
      const linked = await linkPendingFriendRequests(USER_ID, null, null);

      // Assert
      expect(linked).toBe(0);
      expect(mockFakeDb.col("friendRequests").updateMany).not.toHaveBeenCalled();
    });

    it("should return 0 when no pending request targets the new user", async () => {
      // Arrange
      mockFind(mockFakeDb.col("friendRequests"), []);

      // Act
      const linked = await linkPendingFriendRequests(USER_ID, "alice@test.com", null);

      // Assert
      expect(linked).toBe(0);
    });

    it("should attach the pending requests to the new user and notify each sender", async () => {
      // Arrange
      mockFind(mockFakeDb.col("friendRequests"), [{ _id: "r1", senderId: FRIEND_ID }]);
      mockFakeDb.col("users").findOne
        .mockResolvedValueOnce({ _id: new ObjectId(USER_ID), name: encrypt("Alice") })
        .mockResolvedValueOnce({ _id: new ObjectId(FRIEND_ID), email: encrypt("bob@test.com") });

      // Act
      const linked = await linkPendingFriendRequests(USER_ID, "alice@test.com", "+33612345678");

      // Assert
      expect(linked).toBe(1);
      expect(mockFakeDb.col("friendRequests").updateMany).toHaveBeenCalledWith(
        { _id: { $in: ["r1"] } },
        { $set: { recipientId: USER_ID } }
      );
      expect(sendFriendRequestFoundEmail).toHaveBeenCalledWith("bob@test.com", "Alice", "fr");
    });

    it("should return 0 without throwing when the database fails", async () => {
      // Arrange
      mockFakeDb.col("friendRequests").find.mockImplementation(() => {
        throw new Error("mongo down");
      });

      // Act
      const linked = await linkPendingFriendRequests(USER_ID, "alice@test.com", null);

      // Assert
      expect(linked).toBe(0);
    });
  });

  describe("GET /friends/suggestions", () => {
    it("should return an empty list when the user has no friend", async () => {
      // Arrange
      mockFind(mockFakeDb.col("friends"), []);

      // Act
      const res = await request(app).get("/friends/suggestions");

      // Assert
      expect(res.body).toEqual([]);
    });

    it("should return an empty list when friends of friends bring no new candidate", async () => {
      // Arrange
      mockFakeDb.col("friends").find
        .mockReturnValueOnce({ toArray: async () => [{ friendId: FRIEND_ID }] })
        .mockReturnValueOnce({ toArray: async () => [{ userId: FRIEND_ID, friendId: USER_ID }] });

      // Act
      const res = await request(app).get("/friends/suggestions");

      // Assert
      expect(res.body).toEqual([]);
    });

    it("should exclude candidates already involved in a pending request", async () => {
      // Arrange
      mockFakeDb.col("friends").find
        .mockReturnValueOnce({ toArray: async () => [{ friendId: FRIEND_ID }] })
        .mockReturnValueOnce({ toArray: async () => [{ userId: FRIEND_ID, friendId: STRANGER_ID }] });
      mockFind(mockFakeDb.col("friendRequests"), [{ senderId: USER_ID, recipientId: STRANGER_ID }]);

      // Act
      const res = await request(app).get("/friends/suggestions");

      // Assert
      expect(res.body).toEqual([]);
    });

    it("should rank the suggestions by number of common friends", async () => {
      // Arrange
      const otherFriendId = "507f1f77bcf86cd799439044";
      mockFakeDb.col("friends").find
        .mockReturnValueOnce({ toArray: async () => [{ friendId: FRIEND_ID }, { friendId: otherFriendId }] })
        .mockReturnValueOnce({
          toArray: async () => [
            { userId: FRIEND_ID, friendId: STRANGER_ID },
            { userId: otherFriendId, friendId: STRANGER_ID },
            { userId: FRIEND_ID, friendId: "507f1f77bcf86cd799439055" },
          ],
        });
      mockFind(mockFakeDb.col("friendRequests"), []);
      mockFind(mockFakeDb.col("users"), [
        { _id: new ObjectId("507f1f77bcf86cd799439055"), name: encrypt("Chloé") },
        { _id: new ObjectId(STRANGER_ID), name: encrypt("Bob") },
      ]);

      // Act
      const res = await request(app).get("/friends/suggestions");

      // Assert
      expect(res.body.map((s) => s.name)).toEqual(["Bob", "Chloé"]);
      expect(res.body[0].commonFriends).toBe(2);
    });

    it("should return 500 when the database fails", async () => {
      // Arrange
      mockFakeDb.col("friends").find.mockImplementation(() => {
        throw new Error("mongo down");
      });

      // Act
      const res = await request(app).get("/friends/suggestions");

      // Assert
      expect(res.status).toBe(500);
    });
  });

  describe("GET /friends", () => {
    it("should cap the pagination limit at 200", async () => {
      // Arrange
      const cursor = {
        sort: jest.fn(() => cursor),
        skip: jest.fn(() => cursor),
        limit: jest.fn(() => cursor),
        toArray: jest.fn(async () => []),
      };
      mockFakeDb.col("friends").find.mockReturnValue(cursor);

      // Act
      await request(app).get("/friends?limit=9999&skip=-5");

      // Assert
      expect(cursor.limit).toHaveBeenCalledWith(200);
      expect(cursor.skip).toHaveBeenCalledWith(0);
    });

    it("should decrypt the friend fields and prefer the avatar of the user document", async () => {
      // Arrange
      mockFind(mockFakeDb.col("friends"), [
        {
          _id: new ObjectId(),
          userId: USER_ID,
          friendId: FRIEND_ID,
          name: encrypt("Bob"),
          email: encrypt("bob@test.com"),
          phone: null,
          avatar: "ancien-avatar",
        },
      ]);
      mockFind(mockFakeDb.col("users"), [
        { _id: new ObjectId(FRIEND_ID), avatar: "avatar-a-jour" },
      ]);

      // Act
      const res = await request(app).get("/friends");

      // Assert
      expect(res.body[0]).toMatchObject({
        friendId: FRIEND_ID,
        name: "Bob",
        email: "bob@test.com",
        avatar: "avatar-a-jour",
      });
    });

    it("should ignore friend documents carrying a malformed friendId", async () => {
      // Arrange
      mockFind(mockFakeDb.col("friends"), [
        { _id: new ObjectId(), userId: USER_ID, friendId: "pas-un-id" },
      ]);

      // Act
      const res = await request(app).get("/friends");

      // Assert
      expect(res.status).toBe(200);
      expect(mockFakeDb.col("users").find).not.toHaveBeenCalled();
    });

    it("should return 500 when the database fails", async () => {
      // Arrange
      mockFakeDb.col("friends").find.mockImplementation(() => {
        throw new Error("mongo down");
      });

      // Act
      const res = await request(app).get("/friends");

      // Assert
      expect(res.status).toBe(500);
    });
  });

  describe("DELETE /friends/:friendId", () => {
    it("should return 400 when the identifier is not a valid ObjectId", async () => {
      // Act
      const res = await request(app).delete("/friends/pas-un-id");

      // Assert
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "ID invalide" });
    });

    it("should delete the friendship in both directions", async () => {
      // Act
      const res = await request(app).delete(`/friends/${FRIEND_ID}`);

      // Assert
      expect(res.body).toEqual({ success: true });
      expect(mockFakeDb.col("friends").deleteMany).toHaveBeenCalledWith({
        $or: [
          { userId: USER_ID, friendId: FRIEND_ID },
          { userId: FRIEND_ID, friendId: USER_ID },
        ],
      });
    });

    it("should return 500 when the deletion fails", async () => {
      // Arrange
      mockFakeDb.col("friends").deleteMany.mockRejectedValue(new Error("mongo down"));

      // Act
      const res = await request(app).delete(`/friends/${FRIEND_ID}`);

      // Assert
      expect(res.status).toBe(500);
    });
  });

  describe("GET /friends/:friendId/profile", () => {
    it("should return 404 when the user does not exist", async () => {
      // Arrange
      mockFakeDb.col("users").findOne.mockResolvedValue(null);

      // Act
      const res = await request(app).get(`/friends/${FRIEND_ID}/profile`);

      // Assert
      expect(res.status).toBe(404);
    });

    it("should hide the statistics of a private profile", async () => {
      // Arrange
      mockFakeDb.col("users").findOne.mockResolvedValue({
        _id: new ObjectId(FRIEND_ID),
        name: encrypt("Bob"),
        isPublicProfile: false,
      });
      mockFakeDb.col("friends").findOne.mockResolvedValue(null);

      // Act
      const res = await request(app).get(`/friends/${FRIEND_ID}/profile`);

      // Assert
      expect(res.body).toMatchObject({
        name: "Bob",
        isFriend: false,
        isPublicProfile: false,
        stats: null,
        sharedTrips: [],
      });
    });

    it("should expose the statistics and the shared trips of a public profile", async () => {
      // Arrange
      const tripId = new ObjectId();
      mockFakeDb.col("users").findOne.mockResolvedValue({
        _id: new ObjectId(FRIEND_ID),
        name: encrypt("Bob"),
        email: encrypt("bob@test.com"),
        isPublicProfile: true,
      });
      mockFakeDb.col("friends").findOne.mockResolvedValue({ createdAt: new Date(0) });
      mockFakeDb.col("trips").find
        .mockReturnValueOnce({ toArray: async () => [{ _id: tripId, destination: "Italie", title: "Rome" }] })
        .mockReturnValueOnce({ project: () => ({ toArray: async () => [{ _id: tripId }] }) })
        .mockReturnValueOnce({ sort: () => ({ toArray: async () => [{ _id: tripId, title: "Rome", isPublic: true }] }) });
      mockFakeDb.col("friends").find
        .mockReturnValueOnce({ project: () => ({ toArray: async () => [{ friendId: STRANGER_ID }] }) })
        .mockReturnValueOnce({ project: () => ({ toArray: async () => [{ friendId: STRANGER_ID }] }) });
      mockFakeDb.col("bookings").countDocuments.mockResolvedValue(4);

      // Act
      const res = await request(app).get(`/friends/${FRIEND_ID}/profile`);

      // Assert
      expect(res.body.stats).toEqual({
        commonTrips: 1,
        totalTrips: 1,
        countries: 1,
        commonFriends: 1,
        totalBookings: 4,
      });
      expect(res.body.sharedTrips[0].visibility).toBe("public");
    });

    it("should return 500 when the database fails", async () => {
      // Arrange
      mockFakeDb.col("users").findOne.mockRejectedValue(new Error("mongo down"));

      // Act
      const res = await request(app).get(`/friends/${FRIEND_ID}/profile`);

      // Assert
      expect(res.status).toBe(500);
    });
  });
});
