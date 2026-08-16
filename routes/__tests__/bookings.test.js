const request = require("supertest");
const { createApp, silenceConsole } = require("../../__tests__/helpers/routerApp");

const USER_ID = "507f1f77bcf86cd799439011";

jest.mock("../../middleware/auth", () => ({
  requireAuth: (req, _res, next) => {
    req.user = { _id: "507f1f77bcf86cd799439011" };
    next();
  },
}));

jest.mock("../../services/bookingService", () => ({
  getBookingsForUser: jest.fn(),
  getBookingsByTripId: jest.fn(),
  getBookingById: jest.fn(),
  createBooking: jest.fn(),
  updateBooking: jest.fn(),
  deleteBooking: jest.fn(),
}));

const bookingService = require("../../services/bookingService");
const bookingsRouter = require("../bookings");

describe("bookings router", () => {
  let app;
  let restoreConsole;

  beforeAll(() => {
    app = createApp("/bookings", bookingsRouter);
    restoreConsole = silenceConsole();
  });

  afterAll(() => restoreConsole());
  beforeEach(() => jest.clearAllMocks());

  describe("POST /bookings", () => {
    it("should return 201 with the created booking", async () => {
      // Arrange
      bookingService.createBooking.mockResolvedValue({ booking: { title: "Hôtel" } });

      // Act
      const res = await request(app).post("/bookings").send({ title: "Hôtel" });

      // Assert
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ title: "Hôtel" });
    });

    it("should return 400 when the service rejects the payload", async () => {
      // Arrange
      bookingService.createBooking.mockResolvedValue({
        error: "Champs requis manquants (type, title, date)",
        status: 400,
      });

      // Act
      const res = await request(app).post("/bookings").send({});

      // Assert
      expect(res.status).toBe(400);
    });

    it("should return 500 when the service throws", async () => {
      // Arrange
      bookingService.createBooking.mockRejectedValue(new Error("boom"));

      // Act
      const res = await request(app).post("/bookings").send({});

      // Assert
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: "Erreur interne du serveur" });
    });
  });

  describe("GET /bookings", () => {
    it("should return the bookings of the authenticated user", async () => {
      // Arrange
      bookingService.getBookingsForUser.mockResolvedValue([{ title: "Hôtel" }]);

      // Act
      const res = await request(app).get("/bookings");

      // Assert
      expect(res.body).toEqual([{ title: "Hôtel" }]);
      expect(bookingService.getBookingsForUser).toHaveBeenCalledWith(USER_ID);
    });

    it("should return 500 when the service throws", async () => {
      // Arrange
      bookingService.getBookingsForUser.mockRejectedValue(new Error("boom"));

      // Act
      const res = await request(app).get("/bookings");

      // Assert
      expect(res.status).toBe(500);
    });
  });

  describe("GET /bookings/trip/:tripId", () => {
    it("should return the items of the trip", async () => {
      // Arrange
      bookingService.getBookingsByTripId.mockResolvedValue({ items: [{ title: "Hôtel" }] });

      // Act
      const res = await request(app).get("/bookings/trip/trip-1");

      // Assert
      expect(res.body).toEqual([{ title: "Hôtel" }]);
    });

    it("should propagate the status carried by a service error", async () => {
      // Arrange
      bookingService.getBookingsByTripId.mockResolvedValue({ error: "Accès refusé", status: 403 });

      // Act
      const res = await request(app).get("/bookings/trip/trip-1");

      // Assert
      expect(res.status).toBe(403);
    });

    it("should return 500 when the service throws", async () => {
      // Arrange
      bookingService.getBookingsByTripId.mockRejectedValue(new Error("boom"));

      // Act
      const res = await request(app).get("/bookings/trip/trip-1");

      // Assert
      expect(res.status).toBe(500);
    });
  });

  describe("GET /bookings/:id", () => {
    it("should return the single booking returned by the service", async () => {
      // Arrange
      bookingService.getBookingById.mockResolvedValue({ booking: { title: "Hôtel" } });

      // Act
      const res = await request(app).get("/bookings/abc");

      // Assert
      expect(res.body).toEqual({ title: "Hôtel" });
    });

    it("should return 500 when the service throws", async () => {
      // Arrange
      bookingService.getBookingById.mockRejectedValue(new Error("boom"));

      // Act
      const res = await request(app).get("/bookings/abc");

      // Assert
      expect(res.status).toBe(500);
    });
  });

  describe("PUT /bookings/:id", () => {
    it("should forward the id and the body to the service", async () => {
      // Arrange
      bookingService.updateBooking.mockResolvedValue({ booking: { title: "Modifié" } });

      // Act
      await request(app).put("/bookings/abc").send({ title: "Modifié" });

      // Assert
      expect(bookingService.updateBooking).toHaveBeenCalledWith("abc", { title: "Modifié" }, USER_ID);
    });

    it("should return 500 when the service throws", async () => {
      // Arrange
      bookingService.updateBooking.mockRejectedValue(new Error("boom"));

      // Act
      const res = await request(app).put("/bookings/abc").send({});

      // Assert
      expect(res.status).toBe(500);
    });
  });

  describe("DELETE /bookings/:id", () => {
    it("should return the service success payload", async () => {
      // Arrange
      bookingService.deleteBooking.mockResolvedValue({ success: true });

      // Act
      const res = await request(app).delete("/bookings/abc");

      // Assert
      expect(res.body).toEqual({ success: true });
    });

    it("should return 500 when the service throws", async () => {
      // Arrange
      bookingService.deleteBooking.mockRejectedValue(new Error("boom"));

      // Act
      const res = await request(app).delete("/bookings/abc");

      // Assert
      expect(res.status).toBe(500);
    });
  });
});
