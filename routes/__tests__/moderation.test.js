const request = require("supertest");
const { createFakeDb } = require("../../__tests__/helpers/fakeDb");
const { createApp, silenceConsole } = require("../../__tests__/helpers/routerApp");

const USER_ID = "507f1f77bcf86cd799439011";

// Préfixe `mock` obligatoire : la factory de jest.mock est hoistée au-dessus des require.
const mockFakeDb = createFakeDb();
jest.mock("../../db", () => ({ getDb: () => mockFakeDb.db }));

jest.mock("../../middleware/auth", () => ({
  requireAuth: (req, _res, next) => {
    req.user = { _id: "507f1f77bcf86cd799439011" };
    next();
  },
}));

const moderationRouter = require("../moderation");

describe("moderation router", () => {
  let app;
  let restoreConsole;

  beforeAll(() => {
    app = createApp("/moderation", moderationRouter);
    restoreConsole = silenceConsole();
  });

  afterAll(() => restoreConsole());
  beforeEach(() => mockFakeDb.reset());

  describe("POST /moderation/report", () => {
    it("should return 400 when targetType is not user nor trip", async () => {
      // Act
      const res = await request(app)
        .post("/moderation/report")
        .send({ targetType: "comment", targetId: "x", reason: "spam" });

      // Assert
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ success: false, error: "targetType invalide" });
    });

    it("should return 400 when targetId is missing", async () => {
      // Act
      const res = await request(app)
        .post("/moderation/report")
        .send({ targetType: "trip", reason: "spam" });

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("targetId requis");
    });

    it("should return 400 when the reason is not in the allowlist", async () => {
      // Act
      const res = await request(app)
        .post("/moderation/report")
        .send({ targetType: "trip", targetId: "trip-1", reason: "je-n-aime-pas" });

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Raison invalide");
    });

    it("should return 400 when a user reports himself", async () => {
      // Act
      const res = await request(app)
        .post("/moderation/report")
        .send({ targetType: "user", targetId: USER_ID, reason: "spam" });

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Impossible de se signaler soi-même");
    });

    it("should truncate the details to 500 characters", async () => {
      // Act
      await request(app)
        .post("/moderation/report")
        .send({ targetType: "trip", targetId: "trip-1", reason: "spam", details: "a".repeat(600) });

      // Assert
      const [inserted] = mockFakeDb.col("reports").insertOne.mock.calls[0];
      expect(inserted.details).toHaveLength(500);
    });

    it("should store null details when they are not a string", async () => {
      // Act
      const res = await request(app)
        .post("/moderation/report")
        .send({ targetType: "trip", targetId: "trip-1", reason: "other", details: 42 });

      // Assert
      expect(res.body).toEqual({ success: true });
      const [inserted] = mockFakeDb.col("reports").insertOne.mock.calls[0];
      expect(inserted).toMatchObject({ reporterId: USER_ID, status: "pending", details: null });
    });

    it("should return 500 when the insertion fails", async () => {
      // Arrange
      mockFakeDb.col("reports").insertOne.mockRejectedValue(new Error("mongo down"));

      // Act
      const res = await request(app)
        .post("/moderation/report")
        .send({ targetType: "trip", targetId: "trip-1", reason: "spam" });

      // Assert
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ success: false, error: "Erreur interne du serveur" });
    });
  });

  describe("POST /moderation/block/:userId", () => {
    it("should return 400 when a user blocks himself", async () => {
      // Act
      const res = await request(app).post(`/moderation/block/${USER_ID}`);

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Impossible de se bloquer soi-même");
    });

    it("should upsert the block document when the target is another user", async () => {
      // Act
      const res = await request(app).post("/moderation/block/bob");

      // Assert
      expect(res.body).toEqual({ success: true });
      expect(mockFakeDb.col("blocks").updateOne).toHaveBeenCalledWith(
        { blockerId: USER_ID, blockedId: "bob" },
        expect.objectContaining({ $setOnInsert: expect.anything() }),
        { upsert: true }
      );
    });

    it("should return 500 when the upsert fails", async () => {
      // Arrange
      mockFakeDb.col("blocks").updateOne.mockRejectedValue(new Error("mongo down"));

      // Act
      const res = await request(app).post("/moderation/block/bob");

      // Assert
      expect(res.status).toBe(500);
    });
  });

  describe("DELETE /moderation/block/:userId", () => {
    it("should delete the block document", async () => {
      // Act
      const res = await request(app).delete("/moderation/block/bob");

      // Assert
      expect(res.body).toEqual({ success: true });
      expect(mockFakeDb.col("blocks").deleteOne).toHaveBeenCalledWith({
        blockerId: USER_ID,
        blockedId: "bob",
      });
    });

    it("should return 500 when the deletion fails", async () => {
      // Arrange
      mockFakeDb.col("blocks").deleteOne.mockRejectedValue(new Error("mongo down"));

      // Act
      const res = await request(app).delete("/moderation/block/bob");

      // Assert
      expect(res.status).toBe(500);
    });
  });
});
