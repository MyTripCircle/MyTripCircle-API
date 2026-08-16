const request = require("supertest");
const { createApp, silenceConsole } = require("../../__tests__/helpers/routerApp");

const USER_ID = "507f1f77bcf86cd799439011";

jest.mock("../../middleware/auth", () => ({
  requireAuth: (req, _res, next) => {
    req.user = { _id: "507f1f77bcf86cd799439011" };
    next();
  },
}));

jest.mock("../../services/addressService", () => ({
  getAddressesForUser: jest.fn(),
  getAddressesByTripId: jest.fn(),
  getAddressById: jest.fn(),
  createAddress: jest.fn(),
  updateAddress: jest.fn(),
  deleteAddress: jest.fn(),
}));

const addressService = require("../../services/addressService");
const addressesRouter = require("../addresses");

describe("addresses router", () => {
  let app;
  let restoreConsole;

  beforeAll(() => {
    app = createApp("/addresses", addressesRouter);
    restoreConsole = silenceConsole();
  });

  afterAll(() => restoreConsole());
  beforeEach(() => jest.clearAllMocks());

  describe("GET /addresses", () => {
    it("should return the addresses of the authenticated user", async () => {
      // Arrange
      addressService.getAddressesForUser.mockResolvedValue([{ name: "Hôtel" }]);

      // Act
      const res = await request(app).get("/addresses");

      // Assert
      expect(res.body).toEqual([{ name: "Hôtel" }]);
      expect(addressService.getAddressesForUser).toHaveBeenCalledWith(USER_ID);
    });

    it("should return 500 when the service throws", async () => {
      // Arrange
      addressService.getAddressesForUser.mockRejectedValue(new Error("boom"));

      // Act
      const res = await request(app).get("/addresses");

      // Assert
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: "Erreur interne du serveur" });
    });
  });

  describe("GET /addresses/trip/:tripId", () => {
    it("should return the items of the trip", async () => {
      // Arrange
      addressService.getAddressesByTripId.mockResolvedValue({ items: [{ name: "Hôtel" }] });

      // Act
      const res = await request(app).get("/addresses/trip/trip-1");

      // Assert
      expect(res.body).toEqual([{ name: "Hôtel" }]);
    });

    it("should propagate the status carried by a service error", async () => {
      // Arrange
      addressService.getAddressesByTripId.mockResolvedValue({ error: "Voyage introuvable", status: 404 });

      // Act
      const res = await request(app).get("/addresses/trip/trip-1");

      // Assert
      expect(res.status).toBe(404);
    });

    it("should return 500 when the service throws", async () => {
      // Arrange
      addressService.getAddressesByTripId.mockRejectedValue(new Error("boom"));

      // Act
      const res = await request(app).get("/addresses/trip/trip-1");

      // Assert
      expect(res.status).toBe(500);
    });
  });

  describe("GET /addresses/:id", () => {
    it("should return the single item returned by the service", async () => {
      // Arrange
      addressService.getAddressById.mockResolvedValue({ item: { name: "Hôtel" } });

      // Act
      const res = await request(app).get("/addresses/abc");

      // Assert
      expect(res.body).toEqual({ name: "Hôtel" });
    });

    it("should return 500 when the service throws", async () => {
      // Arrange
      addressService.getAddressById.mockRejectedValue(new Error("boom"));

      // Act
      const res = await request(app).get("/addresses/abc");

      // Assert
      expect(res.status).toBe(500);
    });
  });

  describe("POST /addresses", () => {
    it("should return 201 with the created address", async () => {
      // Arrange
      addressService.createAddress.mockResolvedValue({ item: { name: "Hôtel" } });

      // Act
      const res = await request(app).post("/addresses").send({ name: "Hôtel" });

      // Assert
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ name: "Hôtel" });
    });

    it("should return 400 when the service rejects the payload", async () => {
      // Arrange
      addressService.createAddress.mockResolvedValue({ error: "Type invalide", status: 400 });

      // Act
      const res = await request(app).post("/addresses").send({});

      // Assert
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "Type invalide" });
    });

    it("should return 500 when the service throws", async () => {
      // Arrange
      addressService.createAddress.mockRejectedValue(new Error("boom"));

      // Act
      const res = await request(app).post("/addresses").send({});

      // Assert
      expect(res.status).toBe(500);
    });
  });

  describe("PUT /addresses/:id", () => {
    it("should forward the id and the body to the service", async () => {
      // Arrange
      addressService.updateAddress.mockResolvedValue({ item: { city: "Milan" } });

      // Act
      await request(app).put("/addresses/abc").send({ city: "Milan" });

      // Assert
      expect(addressService.updateAddress).toHaveBeenCalledWith("abc", { city: "Milan" }, USER_ID);
    });

    it("should return 500 when the service throws", async () => {
      // Arrange
      addressService.updateAddress.mockRejectedValue(new Error("boom"));

      // Act
      const res = await request(app).put("/addresses/abc").send({});

      // Assert
      expect(res.status).toBe(500);
    });
  });

  describe("DELETE /addresses/:id", () => {
    it("should return the service success payload", async () => {
      // Arrange
      addressService.deleteAddress.mockResolvedValue({ success: true });

      // Act
      const res = await request(app).delete("/addresses/abc");

      // Assert
      expect(res.body).toEqual({ success: true });
    });

    it("should return 500 when the service throws", async () => {
      // Arrange
      addressService.deleteAddress.mockRejectedValue(new Error("boom"));

      // Act
      const res = await request(app).delete("/addresses/abc");

      // Assert
      expect(res.status).toBe(500);
    });
  });
});
