const { createFakeDb } = require("../../__tests__/helpers/fakeDb");

// Préfixe `mock` obligatoire : la factory de jest.mock est hoistée au-dessus des require.
const mockFakeDb = createFakeDb();
const mockGetDb = jest.fn(() => mockFakeDb.db);

jest.mock("../../db", () => ({ getDb: mockGetDb }));
jest.mock("../../utils/logger", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const logger = require("../../utils/logger");
const { auditLog } = require("../auditLog");

/** Attend le tour de boucle suivant pour laisser filer la persistance différée. */
const flushSetImmediate = () => new Promise((resolve) => setImmediate(resolve));

/** Construit une requête Express minimale telle que la voit le middleware. */
function buildRequest(overrides = {}) {
  return {
    method: "GET",
    path: "/users/me/export",
    ip: "203.0.113.7",
    headers: { "user-agent": "jest-agent/1.0" },
    ...overrides,
  };
}

describe("auditLog middleware", () => {
  let next;

  beforeEach(() => {
    mockFakeDb.reset();
    jest.clearAllMocks();
    mockGetDb.mockImplementation(() => mockFakeDb.db);
    next = jest.fn();
  });

  it("should always call next when the route is audited", async () => {
    // Act
    auditLog(buildRequest(), {}, next);
    await flushSetImmediate();

    // Assert
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("should trace the audited access in the application log", async () => {
    // Arrange
    const req = buildRequest({ user: { _id: "507f1f77bcf86cd799439011" } });

    // Act
    auditLog(req, {}, next);

    // Assert
    expect(logger.info).toHaveBeenCalledWith(
      "[audit] GET /users/me/export — userId=507f1f77bcf86cd799439011 — ip=203.0.113.7"
    );
    // La persistance différée est drainée avant la fin du test : sans cela, son
    // `insertOne` retomberait dans le test suivant, qui n'en attend aucun.
    await flushSetImmediate();
  });

  it("should persist the audited access in MongoDB when the route matches", async () => {
    // Arrange
    const req = buildRequest({
      method: "DELETE",
      path: "/users/me",
      user: { _id: "507f1f77bcf86cd799439011" },
    });

    // Act
    auditLog(req, {}, next);
    await flushSetImmediate();

    // Assert
    expect(mockFakeDb.col("auditLogs").insertOne).toHaveBeenCalledWith({
      method: "DELETE",
      path: "/users/me",
      userId: "507f1f77bcf86cd799439011",
      ip: "203.0.113.7",
      userAgent: "jest-agent/1.0",
      createdAt: expect.any(Date),
    });
  });

  it("should record the user as anonymous when the request carries no user", async () => {
    // Act
    auditLog(buildRequest(), {}, next);
    await flushSetImmediate();

    // Assert
    expect(mockFakeDb.col("auditLogs").insertOne).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "anonymous" })
    );
  });

  it("should record a null user agent when the header is absent", async () => {
    // Arrange
    const req = buildRequest({ headers: {} });

    // Act
    auditLog(req, {}, next);
    await flushSetImmediate();

    // Assert
    expect(mockFakeDb.col("auditLogs").insertOne).toHaveBeenCalledWith(
      expect.objectContaining({ userAgent: null })
    );
  });

  it("should skip auditing when the path matches but the method does not", async () => {
    // Arrange — /users/me n'est audité qu'en DELETE
    const req = buildRequest({ method: "PATCH", path: "/users/me" });

    // Act
    auditLog(req, {}, next);
    await flushSetImmediate();

    // Assert
    expect(logger.info).not.toHaveBeenCalled();
    expect(mockFakeDb.col("auditLogs").insertOne).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("should skip auditing when the method matches but the path does not", async () => {
    // Arrange
    const req = buildRequest({ method: "GET", path: "/trips" });

    // Act
    auditLog(req, {}, next);
    await flushSetImmediate();

    // Assert
    expect(logger.info).not.toHaveBeenCalled();
    expect(mockFakeDb.col("auditLogs").insertOne).not.toHaveBeenCalled();
  });

  it("should log an error when the MongoDB insertion is rejected", async () => {
    // Arrange
    mockFakeDb
      .col("auditLogs")
      .insertOne.mockRejectedValue(new Error("écriture refusée"));

    // Act
    auditLog(buildRequest(), {}, next);
    await flushSetImmediate();

    // Assert
    expect(logger.error).toHaveBeenCalledWith(
      "[auditLog] Erreur persistence MongoDB:",
      "écriture refusée"
    );
  });

  it("should warn without throwing when the database is unavailable", async () => {
    // Arrange
    mockGetDb.mockImplementation(() => {
      throw new Error("DB non initialisée");
    });

    // Act
    auditLog(buildRequest(), {}, next);
    await flushSetImmediate();

    // Assert
    expect(logger.warn).toHaveBeenCalledWith(
      "[auditLog] DB non disponible, audit ignoré:",
      "DB non initialisée"
    );
    expect(next).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["POST", "/users/me/cancel-deletion"],
    ["GET", "/users/lookup"],
    ["POST", "/users/batch"],
    ["POST", "/users/consent"],
    ["PUT", "/users/change-password"],
    ["DELETE", "/users/me/account"],
  ])("should audit %s %s as a sensitive personal-data route", async (method, path) => {
    // Act
    auditLog(buildRequest({ method, path }), {}, next);
    await flushSetImmediate();

    // Assert
    expect(mockFakeDb.col("auditLogs").insertOne).toHaveBeenCalledWith(
      expect.objectContaining({ method, path })
    );
  });
});
