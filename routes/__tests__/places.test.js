const request = require("supertest");
const { createApp, silenceConsole } = require("../../__tests__/helpers/routerApp");

jest.mock("../../middleware/auth", () => ({
  requireAuth: (req, _res, next) => {
    req.user = { _id: "507f1f77bcf86cd799439011" };
    next();
  },
}));

const placesRouter = require("../places");

/** Réponse JSON factice de l'API Google Places. */
const jsonResponse = (data) => ({ ok: true, status: 200, json: async () => data });

describe("places router", () => {
  let app;
  let restoreConsole;

  beforeAll(() => {
    app = createApp("/places", placesRouter);
    restoreConsole = silenceConsole();
  });

  afterAll(() => {
    restoreConsole();
    delete global.fetch;
  });

  beforeEach(() => {
    global.fetch = jest.fn();
  });

  describe("GET /places/autocomplete", () => {
    it("should return an empty prediction list when the input is blank", async () => {
      // Act
      const res = await request(app).get("/places/autocomplete?input=%20%20");

      // Assert
      expect(res.body).toEqual({ predictions: [] });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should return an empty prediction list when Google answers ZERO_RESULTS", async () => {
      // Arrange
      global.fetch.mockResolvedValue(jsonResponse({ status: "ZERO_RESULTS" }));

      // Act
      const res = await request(app).get("/places/autocomplete?input=rom");

      // Assert
      expect(res.body).toEqual({ predictions: [] });
    });

    it("should return 502 when Google answers an unexpected status", async () => {
      // Arrange
      global.fetch.mockResolvedValue(jsonResponse({ status: "REQUEST_DENIED" }));

      // Act
      const res = await request(app).get("/places/autocomplete?input=rome");

      // Assert
      expect(res.status).toBe(502);
      expect(res.body).toEqual({ error: "Places API: REQUEST_DENIED" });
    });

    it("should forward the optional location, radius and types parameters", async () => {
      // Arrange
      global.fetch.mockResolvedValue(jsonResponse({ status: "OK", predictions: [{ id: 1 }] }));

      // Act
      const res = await request(app).get(
        "/places/autocomplete?input=rome&location=1,2&radius=500&types=geocode"
      );

      // Assert
      expect(res.body).toEqual({ predictions: [{ id: 1 }] });
      const [url] = global.fetch.mock.calls[0];
      expect(url).toContain("location=1%2C2");
      expect(url).toContain("radius=500");
      expect(url).toContain("types=geocode");
    });

    it("should return 500 when the upstream call fails", async () => {
      // Arrange
      global.fetch.mockRejectedValue(new Error("network down"));

      // Act
      const res = await request(app).get("/places/autocomplete?input=rome");

      // Assert
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: "Erreur interne du serveur" });
    });
  });

  describe("GET /places/details", () => {
    it("should return 400 when placeId is missing", async () => {
      // Act
      const res = await request(app).get("/places/details");

      // Assert
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "placeId requis" });
    });

    it("should return 502 when Google answers an unexpected status", async () => {
      // Arrange
      global.fetch.mockResolvedValue(jsonResponse({ status: "NOT_FOUND" }));

      // Act
      const res = await request(app).get("/places/details?placeId=abc");

      // Assert
      expect(res.status).toBe(502);
    });

    it("should replace the photo references with a proxied URL", async () => {
      // Arrange
      global.fetch.mockResolvedValue(
        jsonResponse({ status: "OK", result: { name: "Hôtel", photos: [{ photo_reference: "réf/1" }] } })
      );

      // Act
      const res = await request(app).get("/places/details?placeId=abc");

      // Assert
      expect(res.body.result.photoUrl).toBe(
        `/places/photo?ref=${encodeURIComponent("réf/1")}&maxwidth=800`
      );
      expect(res.body.result.photos).toBeUndefined();
    });

    it("should omit the photo URL when the place carries no photo", async () => {
      // Arrange
      global.fetch.mockResolvedValue(jsonResponse({ status: "OK", result: { name: "Hôtel" } }));

      // Act
      const res = await request(app).get("/places/details?placeId=abc");

      // Assert
      expect(res.body.result.photoUrl).toBeUndefined();
    });

    it("should return 500 when the upstream call fails", async () => {
      // Arrange
      global.fetch.mockRejectedValue(new Error("network down"));

      // Act
      const res = await request(app).get("/places/details?placeId=abc");

      // Assert
      expect(res.status).toBe(500);
    });
  });

  describe("GET /places/textsearch", () => {
    it("should return an empty result list when the query is blank", async () => {
      // Act
      const res = await request(app).get("/places/textsearch?query=%20");

      // Assert
      expect(res.body).toEqual({ results: [] });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should return an empty result list when Google answers ZERO_RESULTS", async () => {
      // Arrange
      global.fetch.mockResolvedValue(jsonResponse({ status: "ZERO_RESULTS" }));

      // Act
      const res = await request(app).get("/places/textsearch?query=rome");

      // Assert
      expect(res.body).toEqual({ results: [] });
    });

    it("should return 502 with the upstream detail when Google answers an error", async () => {
      // Arrange
      global.fetch.mockResolvedValue(
        jsonResponse({ status: "OVER_QUERY_LIMIT", error_message: "quota dépassé" })
      );

      // Act
      const res = await request(app).get("/places/textsearch?query=rome");

      // Assert
      expect(res.status).toBe(502);
      expect(res.body).toEqual({ error: "Places API: OVER_QUERY_LIMIT", detail: "quota dépassé" });
    });

    it("should return an empty result list when Google answers OK without result", async () => {
      // Arrange
      global.fetch.mockResolvedValue(jsonResponse({ status: "OK", results: [] }));

      // Act
      const res = await request(app).get("/places/textsearch?query=rome");

      // Assert
      expect(res.body).toEqual({ results: [] });
    });

    it("should project each place on the fields consumed by the client", async () => {
      // Arrange
      global.fetch.mockResolvedValue(
        jsonResponse({
          status: "OK",
          results: [
            {
              place_id: "p1",
              name: "Hôtel",
              formatted_address: "1 via Roma",
              rating: 4.5,
              photos: [{ photo_reference: "ref1" }],
            },
            { place_id: "p2" },
          ],
        })
      );

      // Act
      const res = await request(app).get("/places/textsearch?query=rome");

      // Assert
      expect(res.body.results).toEqual([
        {
          place_id: "p1",
          name: "Hôtel",
          formatted_address: "1 via Roma",
          rating: 4.5,
          photoUrl: "/places/photo?ref=ref1&maxwidth=800",
        },
        { place_id: "p2", name: "", formatted_address: "" },
      ]);
    });

    it("should return 500 when the upstream call fails", async () => {
      // Arrange
      global.fetch.mockRejectedValue(new Error("network down"));

      // Act
      const res = await request(app).get("/places/textsearch?query=rome");

      // Assert
      expect(res.status).toBe(500);
    });
  });

  describe("GET /places/photo", () => {
    it("should return 400 when the photo reference is missing", async () => {
      // Act
      const res = await request(app).get("/places/photo");

      // Assert
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "ref requis" });
    });

    it("should propagate the upstream status when the photo cannot be fetched", async () => {
      // Arrange
      global.fetch.mockResolvedValue({ ok: false, status: 404 });

      // Act
      const res = await request(app).get("/places/photo?ref=abc");

      // Assert
      expect(res.status).toBe(404);
    });

    it("should clamp the requested width to the 100-1600 range", async () => {
      // Arrange
      global.fetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => "image/png" },
        arrayBuffer: async () => new TextEncoder().encode("img").buffer,
      });

      // Act
      await request(app).get("/places/photo?ref=abc&maxwidth=9000");

      // Assert
      expect(global.fetch.mock.calls[0][0]).toContain("maxwidth=1600");
    });

    it("should stream the upstream image with its content type", async () => {
      // Arrange
      global.fetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => "image/webp" },
        arrayBuffer: async () => new TextEncoder().encode("img").buffer,
      });

      // Act
      const res = await request(app).get("/places/photo?ref=abc");

      // Assert
      expect(res.headers["content-type"]).toBe("image/webp");
      expect(res.headers["cache-control"]).toBe("public, max-age=86400");
    });

    it("should return 500 when the upstream call fails", async () => {
      // Arrange
      global.fetch.mockRejectedValue(new Error("network down"));

      // Act
      const res = await request(app).get("/places/photo?ref=abc");

      // Assert
      expect(res.status).toBe(500);
    });
  });
});
