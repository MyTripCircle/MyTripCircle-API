const { EventEmitter } = require("node:events");
const request = require("supertest");
const { createFakeDb } = require("../../__tests__/helpers/fakeDb");
const { createApp, silenceConsole } = require("../../__tests__/helpers/routerApp");

const USER_ID = "507f1f77bcf86cd799439011";
const MONTHLY = "com.myapp.monthly";
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// Préfixe `mock` obligatoire : la factory de jest.mock est hoistée au-dessus des require.
const mockFakeDb = createFakeDb();
const mockHttpsRequest = jest.fn();

jest.mock("../../db", () => ({ getDb: () => mockFakeDb.db }));
jest.mock("node:https", () => ({ request: (...args) => mockHttpsRequest(...args) }));

jest.mock("../../middleware/auth", () => ({
  requireAuth: (req, _res, next) => {
    req.user = { _id: "507f1f77bcf86cd799439011" };
    next();
  },
}));

// Les limiteurs de débit sont testés séparément : ici ils ne doivent pas
// interférer avec l'enchaînement des cas.
jest.mock("../../middleware/rateLimiter", () => ({
  authLimiter: (_req, _res, next) => next(),
  generalLimiter: (_req, _res, next) => next(),
  searchLimiter: (_req, _res, next) => next(),
  iapLimiter: (_req, _res, next) => next(),
}));

const subscriptionsRouter = require("../subscriptions");

/** Simule la réponse HTTPS d'Apple pour chaque hôte appelé. */
function mockAppleResponses(payloadByHostname) {
  mockHttpsRequest.mockImplementation((options, cb) => {
    const res = new EventEmitter();
    process.nextTick(() => {
      res.emit("data", JSON.stringify(payloadByHostname[options.hostname]));
      res.emit("end");
    });
    cb(res);
    return { on: jest.fn(), write: jest.fn(), end: jest.fn() };
  });
}

const validBody = { receiptData: "reçu", platform: "ios", productId: MONTHLY };

describe("subscriptions router", () => {
  let app;
  let restoreConsole;

  beforeAll(() => {
    app = createApp("/subscriptions", subscriptionsRouter);
    restoreConsole = silenceConsole();
  });

  afterAll(() => restoreConsole());

  beforeEach(() => {
    mockFakeDb.reset();
    mockHttpsRequest.mockReset();
    process.env.IAP_SKIP_VALIDATION = "true";
    delete process.env.APPLE_SHARED_SECRET;
  });

  describe("GET /subscriptions/me", () => {
    it("should return the free plan when the user has no subscription", async () => {
      // Arrange
      mockFakeDb.col("subscriptions").findOne.mockResolvedValue(null);

      // Act
      const res = await request(app).get("/subscriptions/me");

      // Assert
      expect(res.body).toMatchObject({ plan: "free", status: "active", endDate: null });
      expect(res.body.features.maxTrips).toBe(3);
    });

    it("should expire an active subscription whose end date has passed", async () => {
      // Arrange
      mockFakeDb.col("subscriptions").findOne.mockResolvedValue({
        userId: USER_ID,
        status: "active",
        endDate: new Date(Date.now() - 1000),
      });

      // Act
      const res = await request(app).get("/subscriptions/me");

      // Assert
      expect(res.body.status).toBe("expired");
      expect(mockFakeDb.col("subscriptions").updateOne).toHaveBeenCalledWith(
        { userId: USER_ID },
        { $set: expect.objectContaining({ status: "expired" }) }
      );
    });

    it("should return an active subscription untouched when it is still valid", async () => {
      // Arrange
      mockFakeDb.col("subscriptions").findOne.mockResolvedValue({
        userId: USER_ID,
        status: "active",
        endDate: new Date(Date.now() + THIRTY_DAYS_MS),
      });

      // Act
      const res = await request(app).get("/subscriptions/me");

      // Assert
      expect(res.body.status).toBe("active");
      expect(mockFakeDb.col("subscriptions").updateOne).not.toHaveBeenCalled();
    });

    it("should return 500 when the lookup fails", async () => {
      // Arrange
      mockFakeDb.col("subscriptions").findOne.mockRejectedValue(new Error("mongo down"));

      // Act
      const res = await request(app).get("/subscriptions/me");

      // Assert
      expect(res.status).toBe(500);
    });
  });

  describe("POST /subscriptions/validate-receipt", () => {
    it("should return 400 when the receipt is not a string", async () => {
      // Act
      const res = await request(app)
        .post("/subscriptions/validate-receipt")
        .send({ receipt: 42, platform: "ios", productId: MONTHLY });

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Reçu manquant ou invalide");
    });

    it("should return 400 when the platform is unknown", async () => {
      // Act
      const res = await request(app)
        .post("/subscriptions/validate-receipt")
        .send({ receipt: "reçu", platform: "windows", productId: MONTHLY });

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Plateforme invalide");
    });

    it("should return 400 when the productId is not a known plan", async () => {
      // Act
      const res = await request(app)
        .post("/subscriptions/validate-receipt")
        .send({ receipt: "reçu", platform: "ios", productId: "com.myapp.unknown" });

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("ProductId inconnu");
    });

    it("should upsert a premium subscription when the validation is skipped", async () => {
      // Act
      const res = await request(app)
        .post("/subscriptions/validate-receipt")
        .send({ receipt: "reçu", platform: "ios", productId: MONTHLY });

      // Assert
      expect(res.body).toEqual({ success: true });
      const [filter, update, options] = mockFakeDb.col("subscriptions").updateOne.mock.calls[0];
      expect(filter).toEqual({ userId: USER_ID });
      expect(options).toEqual({ upsert: true });
      expect(update.$set.plan).toBe("premium");
      expect(update.$set.endDate - update.$set.startDate).toBe(THIRTY_DAYS_MS);
    });

    it("should return 400 carrying the failure reason when the persistence fails", async () => {
      // Arrange
      mockFakeDb.col("subscriptions").updateOne.mockRejectedValue(new Error("mongo down"));

      // Act
      const res = await request(app)
        .post("/subscriptions/validate-receipt")
        .send({ receipt: "reçu", platform: "ios", productId: MONTHLY });

      // Assert
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ success: false, error: "mongo down" });
    });
  });

  describe("POST /subscriptions/validate — Android", () => {
    it("should refuse an Android purchase when the Apple bypass is disabled", async () => {
      // Arrange
      process.env.IAP_SKIP_VALIDATION = "false";

      // Act
      const res = await request(app)
        .post("/subscriptions/validate")
        .send({ ...validBody, platform: "android" });

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(
        "Validation Google Play non implémentée — achats Android refusés en production"
      );
    });

    it("should accept an Android purchase in bypass mode", async () => {
      // Act
      const res = await request(app)
        .post("/subscriptions/validate")
        .send({ ...validBody, platform: "android" });

      // Assert
      expect(res.body).toEqual({ success: true });
      const [, update] = mockFakeDb.col("subscriptions").updateOne.mock.calls[0];
      expect(update.$set.platform).toBe("android");
    });
  });

  describe("POST /subscriptions/validate — iOS receipt verification", () => {
    beforeEach(() => {
      process.env.IAP_SKIP_VALIDATION = "false";
      process.env.APPLE_SHARED_SECRET = "shared-secret";
    });

    it("should return 400 when the Apple shared secret is not configured", async () => {
      // Arrange
      delete process.env.APPLE_SHARED_SECRET;

      // Act
      const res = await request(app).post("/subscriptions/validate").send(validBody);

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("APPLE_SHARED_SECRET non configuré");
    });

    it("should return 400 when Apple rejects the receipt", async () => {
      // Arrange
      mockAppleResponses({ "buy.itunes.apple.com": { status: 21002 } });

      // Act
      const res = await request(app).post("/subscriptions/validate").send(validBody);

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Reçu Apple invalide (status 21002)");
    });

    it("should retry on the sandbox endpoint when Apple answers 21007", async () => {
      // Arrange
      const expiresMs = Date.now() + THIRTY_DAYS_MS;
      mockAppleResponses({
        "buy.itunes.apple.com": { status: 21007 },
        "sandbox.itunes.apple.com": {
          status: 0,
          latest_receipt_info: [
            { product_id: MONTHLY, purchase_date_ms: "1", expires_date_ms: String(expiresMs), transaction_id: "tx-1" },
          ],
        },
      });

      // Act
      const res = await request(app).post("/subscriptions/validate").send(validBody);

      // Assert
      expect(res.body).toEqual({ success: true });
      expect(mockHttpsRequest.mock.calls.map(([options]) => options.hostname)).toEqual([
        "buy.itunes.apple.com",
        "sandbox.itunes.apple.com",
      ]);
    });

    it("should keep the most recent transaction of the requested product", async () => {
      // Arrange
      const expiresMs = Date.now() + THIRTY_DAYS_MS;
      mockAppleResponses({
        "buy.itunes.apple.com": {
          status: 0,
          latest_receipt_info: [
            { product_id: MONTHLY, purchase_date_ms: "100", expires_date_ms: "1", transaction_id: "old" },
            { product_id: MONTHLY, purchase_date_ms: "200", expires_date_ms: String(expiresMs), transaction_id: "recent" },
            { product_id: "com.myapp.yearly", purchase_date_ms: "300", expires_date_ms: String(expiresMs), transaction_id: "other-plan" },
          ],
        },
      });

      // Act
      await request(app).post("/subscriptions/validate").send(validBody);

      // Assert
      const [, update] = mockFakeDb.col("subscriptions").updateOne.mock.calls[0];
      expect(update.$set.transactionId).toBe("recent");
      expect(update.$set.endDate.getTime()).toBe(expiresMs);
    });

    it("should return 400 when the receipt holds no transaction for the product", async () => {
      // Arrange
      mockAppleResponses({ "buy.itunes.apple.com": { status: 0, receipt: { in_app: [] } } });

      // Act
      const res = await request(app).post("/subscriptions/validate").send(validBody);

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Transaction introuvable dans le reçu Apple");
    });

    it("should return 400 when the matched transaction is already expired", async () => {
      // Arrange
      mockAppleResponses({
        "buy.itunes.apple.com": {
          status: 0,
          receipt: {
            in_app: [
              { product_id: MONTHLY, purchase_date_ms: "1", expires_date_ms: String(Date.now() - 1000) },
            ],
          },
        },
      });

      // Act
      const res = await request(app).post("/subscriptions/validate").send(validBody);

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Abonnement expiré ou invalide");
    });

    it("should return 400 when Apple answers a non-JSON payload", async () => {
      // Arrange
      mockHttpsRequest.mockImplementation((_options, cb) => {
        const res = new EventEmitter();
        process.nextTick(() => {
          res.emit("data", "<html>maintenance</html>");
          res.emit("end");
        });
        cb(res);
        return { on: jest.fn(), write: jest.fn(), end: jest.fn() };
      });

      // Act
      const res = await request(app).post("/subscriptions/validate").send(validBody);

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Réponse Apple non-JSON");
    });

    it("should return 400 when the HTTPS request itself fails", async () => {
      // Arrange
      mockHttpsRequest.mockImplementation(() => {
        const req = {
          on: (event, handler) => {
            if (event === "error") process.nextTick(() => handler(new Error("socket fermé")));
            return req;
          },
          write: jest.fn(),
          end: jest.fn(),
        };
        return req;
      });

      // Act
      const res = await request(app).post("/subscriptions/validate").send(validBody);

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("socket fermé");
    });
  });

  describe("POST /subscriptions/cancel", () => {
    it("should return 400 when no active subscription exists", async () => {
      // Arrange
      mockFakeDb.col("subscriptions").findOne.mockResolvedValue(null);

      // Act
      const res = await request(app).post("/subscriptions/cancel");

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Aucun abonnement actif à annuler");
    });

    it("should return 400 when the subscription is already cancelled", async () => {
      // Arrange
      mockFakeDb.col("subscriptions").findOne.mockResolvedValue({ status: "cancelled" });

      // Act
      const res = await request(app).post("/subscriptions/cancel");

      // Assert
      expect(res.status).toBe(400);
    });

    it("should mark an active subscription as cancelled", async () => {
      // Arrange
      mockFakeDb.col("subscriptions").findOne.mockResolvedValue({ status: "active" });

      // Act
      const res = await request(app).post("/subscriptions/cancel");

      // Assert
      expect(res.body.success).toBe(true);
      const [, update] = mockFakeDb.col("subscriptions").updateOne.mock.calls[0];
      expect(update.$set.status).toBe("cancelled");
      expect(update.$set.cancelledAt).toBeDefined();
    });

    it("should return 500 when the update fails", async () => {
      // Arrange
      mockFakeDb.col("subscriptions").findOne.mockResolvedValue({ status: "active" });
      mockFakeDb.col("subscriptions").updateOne.mockRejectedValue(new Error("mongo down"));

      // Act
      const res = await request(app).post("/subscriptions/cancel");

      // Assert
      expect(res.status).toBe(500);
    });
  });
});
