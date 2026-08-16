const request = require("supertest");
const { createApp, silenceConsole } = require("../../__tests__/helpers/routerApp");

const USER_ID = "507f1f77bcf86cd799439011";

jest.mock("../../middleware/auth", () => ({
  requireAuth: (req, _res, next) => {
    req.user = { _id: "507f1f77bcf86cd799439011", name: "Alice" };
    next();
  },
}));

jest.mock("../../services/tripService", () => ({
  getTripsForUser: jest.fn(),
  getTripById: jest.fn(),
  createTrip: jest.fn(),
  updateTrip: jest.fn(),
  deleteTrip: jest.fn(),
  removeTripCollaborator: jest.fn(),
  transferTripOwnership: jest.fn(),
}));

const tripService = require("../../services/tripService");
const tripsRouter = require("../trips");

describe("trips router", () => {
  let app;
  let restoreConsole;

  beforeAll(() => {
    app = createApp("/trips", tripsRouter);
    restoreConsole = silenceConsole();
  });

  afterAll(() => restoreConsole());
  beforeEach(() => jest.clearAllMocks());

  describe("GET /trips", () => {
    it("should return the trips of the authenticated user", async () => {
      // Arrange
      tripService.getTripsForUser.mockResolvedValue([{ title: "Rome" }]);

      // Act
      const res = await request(app).get("/trips");

      // Assert
      expect(res.status).toBe(200);
      expect(res.body).toEqual([{ title: "Rome" }]);
    });

    it("should forward the authenticated user id to the service", async () => {
      // Arrange
      tripService.getTripsForUser.mockResolvedValue([]);

      // Act
      await request(app).get("/trips");

      // Assert
      expect(tripService.getTripsForUser).toHaveBeenCalledWith(USER_ID);
    });

    it("should return 500 when the service throws", async () => {
      // Arrange
      tripService.getTripsForUser.mockRejectedValue(new Error("mongo down"));

      // Act
      const res = await request(app).get("/trips");

      // Assert
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: "Erreur interne du serveur" });
    });
  });

  describe("GET /trips/:id", () => {
    it("should return the trip when the service grants access", async () => {
      // Arrange
      tripService.getTripById.mockResolvedValue({ trip: { title: "Rome" } });

      // Act
      const res = await request(app).get("/trips/abc");

      // Assert
      expect(res.body).toEqual({ title: "Rome" });
    });

    it("should propagate the status carried by a service error", async () => {
      // Arrange
      tripService.getTripById.mockResolvedValue({ error: "Accès refusé", status: 403 });

      // Act
      const res = await request(app).get("/trips/abc");

      // Assert
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "Accès refusé" });
    });

    it("should return 500 when the service throws", async () => {
      // Arrange
      tripService.getTripById.mockRejectedValue(new Error("boom"));

      // Act
      const res = await request(app).get("/trips/abc");

      // Assert
      expect(res.status).toBe(500);
    });
  });

  describe("POST /trips", () => {
    it("should return 201 with the created trip", async () => {
      // Arrange
      tripService.createTrip.mockResolvedValue({ trip: { title: "Rome" } });

      // Act
      const res = await request(app).post("/trips").send({ title: "Rome" });

      // Assert
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ title: "Rome" });
    });

    it("should return 400 when the service rejects the payload", async () => {
      // Arrange
      tripService.createTrip.mockResolvedValue({ error: "Champs requis manquants", status: 400 });

      // Act
      const res = await request(app).post("/trips").send({});

      // Assert
      expect(res.status).toBe(400);
    });

    it("should return 500 when the service throws", async () => {
      // Arrange
      tripService.createTrip.mockRejectedValue(new Error("boom"));

      // Act
      const res = await request(app).post("/trips").send({});

      // Assert
      expect(res.status).toBe(500);
    });
  });

  describe("PUT /trips/:id", () => {
    it("should forward the body and the trip id to the service", async () => {
      // Arrange
      tripService.updateTrip.mockResolvedValue({ trip: { title: "Milan" } });

      // Act
      await request(app).put("/trips/abc").send({ title: "Milan" });

      // Assert
      expect(tripService.updateTrip).toHaveBeenCalledWith("abc", { title: "Milan" }, USER_ID);
    });

    it("should return 500 when the service throws", async () => {
      // Arrange
      tripService.updateTrip.mockRejectedValue(new Error("boom"));

      // Act
      const res = await request(app).put("/trips/abc").send({});

      // Assert
      expect(res.status).toBe(500);
    });
  });

  describe("DELETE /trips/:id", () => {
    it("should return the service success payload", async () => {
      // Arrange
      tripService.deleteTrip.mockResolvedValue({ success: true });

      // Act
      const res = await request(app).delete("/trips/abc");

      // Assert
      expect(res.body).toEqual({ success: true });
    });

    it("should return 500 when the service throws", async () => {
      // Arrange
      tripService.deleteTrip.mockRejectedValue(new Error("boom"));

      // Act
      const res = await request(app).delete("/trips/abc");

      // Assert
      expect(res.status).toBe(500);
    });
  });

  describe("DELETE /trips/:id/collaborators/:userId", () => {
    it("should forward both identifiers to the service", async () => {
      // Arrange
      tripService.removeTripCollaborator.mockResolvedValue({ success: true });

      // Act
      await request(app).delete("/trips/abc/collaborators/bob");

      // Assert
      expect(tripService.removeTripCollaborator).toHaveBeenCalledWith("abc", "bob", USER_ID);
    });

    it("should return 500 when the service throws", async () => {
      // Arrange
      tripService.removeTripCollaborator.mockRejectedValue(new Error("boom"));

      // Act
      const res = await request(app).delete("/trips/abc/collaborators/bob");

      // Assert
      expect(res.status).toBe(500);
    });
  });

  describe("PUT /trips/:id/transfer-ownership", () => {
    it("should forward the new owner id to the service", async () => {
      // Arrange
      tripService.transferTripOwnership.mockResolvedValue({ success: true });

      // Act
      await request(app).put("/trips/abc/transfer-ownership").send({ newOwnerId: "bob" });

      // Assert
      expect(tripService.transferTripOwnership).toHaveBeenCalledWith("abc", "bob", USER_ID);
    });

    it("should return 500 when the service throws", async () => {
      // Arrange
      tripService.transferTripOwnership.mockRejectedValue(new Error("boom"));

      // Act
      const res = await request(app).put("/trips/abc/transfer-ownership").send({});

      // Assert
      expect(res.status).toBe(500);
    });
  });
});
