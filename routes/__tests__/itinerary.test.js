const request = require("supertest");
const { createFakeDb } = require("../../__tests__/helpers/fakeDb");
const { createApp, silenceConsole } = require("../../__tests__/helpers/routerApp");

const USER_ID = "507f1f77bcf86cd799439011";
const DAY_MS = 24 * 60 * 60 * 1000;

// Préfixe `mock` obligatoire : la factory de jest.mock est hoistée au-dessus des require.
const mockFakeDb = createFakeDb();
jest.mock("../../db", () => ({ getDb: () => mockFakeDb.db }));

jest.mock("../../middleware/auth", () => ({
  requireAuth: (req, _res, next) => {
    req.user = { _id: "507f1f77bcf86cd799439011" };
    next();
  },
}));

// La clé du fournisseur d'IA est lue au chargement de `config` : on la fixe donc
// avant de charger le routeur, pour couvrir le chemin nominal.
process.env.GROQ_API_KEY = "clé-de-test";
const itineraryRouter = require("../itinerary");

/** Réponse Groq factice portant le contenu textuel du modèle. */
const groqResponse = (content) => ({
  ok: true,
  json: async () => ({ choices: [{ message: { content } }] }),
});

const validItinerary = { city: "rome", days: [{ day: 1, title: "Centre historique" }] };

describe("itinerary router", () => {
  let app;
  let restoreConsole;

  beforeAll(() => {
    app = createApp("/itinerary", itineraryRouter);
    restoreConsole = silenceConsole();
  });

  afterAll(() => {
    restoreConsole();
    delete global.fetch;
  });

  beforeEach(() => {
    mockFakeDb.reset();
    global.fetch = jest.fn();
  });

  describe("input validation", () => {
    it("should return 400 when the city is missing", async () => {
      // Act
      const res = await request(app).post("/itinerary/generate").send({ days: 2 });

      // Assert
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "invalid_city" });
    });

    it("should return 400 when the number of days is out of range", async () => {
      // Act
      const res = await request(app).post("/itinerary/generate").send({ city: "Rome", days: 31 });

      // Assert
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "invalid_days" });
    });

    it("should return 400 when the city contains unexpected characters", async () => {
      // Act
      const res = await request(app)
        .post("/itinerary/generate")
        .send({ city: "Rome<script>", days: 2 });

      // Assert
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "invalid_city" });
    });
  });

  describe("daily quota", () => {
    it("should return 429 with the remaining delay when the daily limit is reached", async () => {
      // Arrange
      mockFakeDb.col("itinerary_usage").countDocuments.mockResolvedValue(10);
      mockFakeDb.col("itinerary_usage").findOne.mockResolvedValue({
        createdAt: new Date(Date.now() - DAY_MS + 60 * 1000),
      });

      // Act
      const res = await request(app).post("/itinerary/generate").send({ city: "Rome", days: 2 });

      // Assert
      expect(res.status).toBe(429);
      expect(res.body.error).toBe("daily_limit_reached");
      expect(res.body.resetIn).toBeGreaterThan(0);
    });

    it("should report a null delay when the oldest usage cannot be read", async () => {
      // Arrange
      mockFakeDb.col("itinerary_usage").countDocuments.mockResolvedValue(10);
      mockFakeDb.col("itinerary_usage").findOne.mockResolvedValue(null);

      // Act
      const res = await request(app).post("/itinerary/generate").send({ city: "Rome", days: 2 });

      // Assert
      expect(res.body.resetIn).toBe(0);
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe("cache", () => {
    it("should serve the cached itinerary without calling the AI provider", async () => {
      // Arrange
      mockFakeDb.col("itinerary_cache").findOne.mockResolvedValue({ itinerary: validItinerary });

      // Act
      const res = await request(app).post("/itinerary/generate").send({ city: "Rome", days: 2 });

      // Assert
      expect(res.body).toEqual({ cached: true, itinerary: validItinerary });
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe("generation", () => {
    it("should return a parse error when the model answers without content", async () => {
      // Arrange
      global.fetch.mockResolvedValue({ ok: true, json: async () => ({ choices: [] }) });

      // Act
      const res = await request(app).post("/itinerary/generate").send({ city: "Rome", days: 2 });

      // Assert
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: "parse_error" });
    });

    it("should return a parse error when the answer holds no JSON object", async () => {
      // Arrange
      global.fetch.mockResolvedValue(groqResponse("désolé, je ne peux pas"));

      // Act
      const res = await request(app).post("/itinerary/generate").send({ city: "Rome", days: 2 });

      // Assert
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: "parse_error" });
    });

    it("should extract the JSON object surrounded by prose and cache it", async () => {
      // Arrange
      global.fetch.mockResolvedValue(
        groqResponse(`Voici l'itinéraire : ${JSON.stringify(validItinerary)} Bon voyage !`)
      );

      // Act
      const res = await request(app).post("/itinerary/generate").send({ city: "  Rome  ", days: "2" });

      // Assert
      expect(res.body).toEqual({ cached: false, itinerary: validItinerary });
      const [cached] = mockFakeDb.col("itinerary_cache").insertOne.mock.calls[0];
      expect(cached).toMatchObject({ city: "rome", days: 2, version: 2 });
      const [usage] = mockFakeDb.col("itinerary_usage").insertOne.mock.calls[0];
      expect(usage.userId).toBe(USER_ID);
    });

    it("should still answer when the cache write fails", async () => {
      // Arrange
      global.fetch.mockResolvedValue(groqResponse(JSON.stringify(validItinerary)));
      mockFakeDb.col("itinerary_cache").insertOne.mockRejectedValue(new Error("mongo down"));

      // Act
      const res = await request(app).post("/itinerary/generate").send({ city: "Rome", days: 2 });

      // Assert
      expect(res.body.cached).toBe(false);
    });

    it("should return 500 when the AI provider is unreachable", async () => {
      // Arrange
      global.fetch.mockRejectedValue(new Error("network down"));

      // Act
      const res = await request(app).post("/itinerary/generate").send({ city: "Rome", days: 2 });

      // Assert
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: "Erreur interne du serveur" });
    });
  });

  describe("when the AI provider is not configured", () => {
    it("should return 503 without calling the provider", async () => {
      // Arrange
      let routerWithoutKey;
      process.env.GROQ_API_KEY = "";
      jest.isolateModules(() => {
        routerWithoutKey = require("../itinerary");
      });
      process.env.GROQ_API_KEY = "clé-de-test";
      const isolatedApp = createApp("/itinerary", routerWithoutKey);

      // Act
      const res = await request(isolatedApp).post("/itinerary/generate").send({ city: "Rome", days: 2 });

      // Assert
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: "ai_not_configured" });
    });
  });
});
