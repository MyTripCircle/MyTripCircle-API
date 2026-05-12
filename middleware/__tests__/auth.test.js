const request = require("supertest");
const express = require("express");
const jwt = require("jsonwebtoken");
const { ObjectId } = require("mongodb");

// Doit être préfixé `mock*` pour être référençable dans la factory de jest.mock (hoistée).
const mockFindOne = jest.fn();
jest.mock("../../db", () => ({
  getDb: () => ({ collection: () => ({ findOne: mockFindOne }) }),
}));

const { requireAuth } = require("../auth");
const { JWT_SECRET } = require("../../config");

const VALID_USER_ID = "507f1f77bcf86cd799439011";

function buildApp() {
  const app = express();
  app.get("/protected", requireAuth, (req, res) => res.json({ ok: true, user: req.user }));
  return app;
}

function bearerFor(userId) {
  return `Bearer ${jwt.sign({ id: userId }, JWT_SECRET, { expiresIn: "15m" })}`;
}

describe("requireAuth middleware", () => {
  let app;
  let warnSpy;

  beforeAll(() => {
    app = buildApp();
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterAll(() => warnSpy.mockRestore());
  beforeEach(() => mockFindOne.mockReset());

  it("should return 401 when the Authorization header is missing", async () => {
    const res = await request(app).get("/protected");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ success: false, error: "Non autorisé" });
  });

  it("should return 401 when the Bearer token is invalid", async () => {
    const res = await request(app).get("/protected").set("Authorization", "Bearer pas-un-jwt");
    expect(res.status).toBe(401);
    expect(mockFindOne).not.toHaveBeenCalled();
  });

  it("should return 401 when the user no longer exists", async () => {
    mockFindOne.mockResolvedValue(null);
    const res = await request(app).get("/protected").set("Authorization", bearerFor(VALID_USER_ID));
    expect(res.status).toBe(401);
  });

  it("should attach req.user and continue when the token is valid", async () => {
    mockFindOne.mockResolvedValue({
      _id: new ObjectId(VALID_USER_ID),
      name: "Alice",
      email: "alice@test.com",
    });
    const res = await request(app).get("/protected").set("Authorization", bearerFor(VALID_USER_ID));
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.user.name).toBe("Alice");
  });

  it("should return 403 when the account is pending deletion", async () => {
    mockFindOne.mockResolvedValue({
      _id: new ObjectId(VALID_USER_ID),
      name: "Bob",
      pendingDeletion: true,
      deletionScheduledAt: new Date("2026-06-01T00:00:00.000Z"),
    });
    const res = await request(app).get("/protected").set("Authorization", bearerFor(VALID_USER_ID));
    expect(res.status).toBe(403);
    expect(res.body.pendingDeletion).toBe(true);
  });
});
