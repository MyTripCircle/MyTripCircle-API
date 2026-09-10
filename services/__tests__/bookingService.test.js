const { ObjectId } = require("mongodb");
const { createFakeDb, mockFind } = require("../../__tests__/helpers/fakeDb");

// Préfixe `mock` obligatoire : la factory de jest.mock est hoistée au-dessus des require.
const mockFakeDb = createFakeDb();
jest.mock("../../db", () => ({ getDb: () => mockFakeDb.db }));

const bookingService = require("../bookingService");

const BOOKING_ID = "507f1f77bcf86cd799439011";
const TRIP_ID = "507f1f77bcf86cd799439022";
const USER_ID = "user-1";
const OTHER_ID = "other-1";
const NOW = new Date("2026-06-15T10:00:00.000Z");

const buildTrip = (overrides = {}) => ({
  _id: new ObjectId(TRIP_ID),
  ownerId: USER_ID,
  collaborators: [],
  visibility: "private",
  ...overrides,
});

describe("bookingService", () => {
  beforeEach(() => {
    mockFakeDb.reset();
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });

  afterEach(() => jest.useRealTimers());

  describe("getBookingsForUser", () => {
    it("should query bookings of the user trips and his standalone bookings", async () => {
      // Arrange
      mockFind(mockFakeDb.col("trips"), [{ _id: new ObjectId(TRIP_ID) }]);
      mockFind(mockFakeDb.col("bookings"), [{ _id: "b1" }]);

      // Act
      const result = await bookingService.getBookingsForUser(USER_ID);

      // Assert
      expect(result).toEqual([{ _id: "b1" }]);
      expect(mockFakeDb.col("bookings").find).toHaveBeenCalledWith({
        $or: [
          { tripId: { $in: [TRIP_ID] } },
          { userId: USER_ID, tripId: { $in: ["", null] } },
          { userId: USER_ID, tripId: { $exists: false } },
        ],
      });
    });
  });

  describe("getBookingsByTripId", () => {
    it("should return a 403 error when the trip does not exist", async () => {
      // Arrange
      mockFakeDb.col("trips").findOne.mockResolvedValue(null);

      // Act
      const result = await bookingService.getBookingsByTripId(TRIP_ID, USER_ID);

      // Assert
      expect(result).toEqual({ error: "Accès refusé", status: 403 });
    });

    it("should return a 403 error when the trip is private and the user is a stranger", async () => {
      // Arrange
      mockFakeDb.col("trips").findOne.mockResolvedValue(buildTrip());

      // Act
      const result = await bookingService.getBookingsByTripId(TRIP_ID, OTHER_ID);

      // Assert
      expect(result).toEqual({ error: "Accès refusé", status: 403 });
    });

    it("should return the bookings when the user collaborates on the trip", async () => {
      // Arrange
      mockFakeDb.col("trips").findOne.mockResolvedValue(
        buildTrip({ collaborators: [{ userId: OTHER_ID }] })
      );
      mockFind(mockFakeDb.col("bookings"), [{ _id: "b1" }]);

      // Act
      const result = await bookingService.getBookingsByTripId(TRIP_ID, OTHER_ID);

      // Assert
      expect(result).toEqual({ items: [{ _id: "b1" }] });
    });

    it("should return the bookings of a public trip to any user", async () => {
      // Arrange
      mockFakeDb.col("trips").findOne.mockResolvedValue(buildTrip({ visibility: "public" }));
      mockFind(mockFakeDb.col("bookings"), []);

      // Act
      const result = await bookingService.getBookingsByTripId(TRIP_ID, OTHER_ID);

      // Assert
      expect(result).toEqual({ items: [] });
    });

    it("should grant access when visibility is friends and a friendship exists", async () => {
      // Arrange
      mockFakeDb.col("trips").findOne.mockResolvedValue(buildTrip({ visibility: "friends" }));
      mockFakeDb.col("friends").findOne.mockResolvedValue({ userId: OTHER_ID });
      mockFind(mockFakeDb.col("bookings"), []);

      // Act
      const result = await bookingService.getBookingsByTripId(TRIP_ID, OTHER_ID);

      // Assert
      expect(result).toEqual({ items: [] });
    });

    it("should deny access when visibility is friends and no friendship exists", async () => {
      // Arrange
      mockFakeDb.col("trips").findOne.mockResolvedValue(buildTrip({ visibility: "friends" }));
      mockFakeDb.col("friends").findOne.mockResolvedValue(null);

      // Act
      const result = await bookingService.getBookingsByTripId(TRIP_ID, OTHER_ID);

      // Assert
      expect(result).toEqual({ error: "Accès refusé", status: 403 });
    });
  });

  describe("getBookingById", () => {
    it("should return a 404 error when the booking does not exist", async () => {
      // Arrange
      mockFakeDb.col("bookings").findOne.mockResolvedValue(null);

      // Act
      const result = await bookingService.getBookingById(BOOKING_ID, USER_ID);

      // Assert
      expect(result).toEqual({ error: "Réservation introuvable", status: 404 });
    });

    it("should return a 403 error when a standalone booking belongs to someone else", async () => {
      // Arrange
      mockFakeDb.col("bookings").findOne.mockResolvedValue({ _id: BOOKING_ID, userId: OTHER_ID });

      // Act
      const result = await bookingService.getBookingById(BOOKING_ID, USER_ID);

      // Assert
      expect(result).toEqual({ error: "Accès refusé", status: 403 });
    });

    it("should return the booking when it belongs to the user", async () => {
      // Arrange
      const booking = { _id: BOOKING_ID, userId: USER_ID };
      mockFakeDb.col("bookings").findOne.mockResolvedValue(booking);

      // Act
      const result = await bookingService.getBookingById(BOOKING_ID, USER_ID);

      // Assert
      expect(result).toEqual({ booking });
    });

    it("should return the booking of a trip the user can read even if he did not create it", async () => {
      // Arrange
      const booking = { _id: BOOKING_ID, userId: OTHER_ID, tripId: TRIP_ID };
      mockFakeDb.col("bookings").findOne.mockResolvedValue(booking);
      mockFakeDb.col("trips").findOne.mockResolvedValue(buildTrip());

      // Act
      const result = await bookingService.getBookingById(BOOKING_ID, USER_ID);

      // Assert
      expect(result).toEqual({ booking });
    });

    it("should return a 403 error when the user can read neither the trip nor the booking", async () => {
      // Arrange
      mockFakeDb.col("bookings").findOne.mockResolvedValue({
        _id: BOOKING_ID,
        userId: "someone-else",
        tripId: TRIP_ID,
      });
      mockFakeDb.col("trips").findOne.mockResolvedValue(buildTrip({ ownerId: "someone-else" }));

      // Act
      const result = await bookingService.getBookingById(BOOKING_ID, USER_ID);

      // Assert
      expect(result).toEqual({ error: "Accès refusé", status: 403 });
    });
  });

  describe("createBooking", () => {
    it("should return a 400 error when a required field is missing", async () => {
      // Act
      const result = await bookingService.createBooking({ type: "hotel" }, USER_ID);

      // Assert
      expect(result).toEqual({
        error: "Champs requis manquants (type, title, date)",
        status: 400,
      });
    });

    it("should apply the default currency, status and empty trip when they are omitted", async () => {
      // Arrange
      mockFakeDb.col("bookings").insertOne.mockResolvedValue({ insertedId: "new-booking" });

      // Act
      const { booking } = await bookingService.createBooking(
        { type: "hotel", title: "  Hôtel Rome  ", date: "2026-07-01T00:00:00.000Z" },
        USER_ID
      );

      // Assert
      expect(booking).toMatchObject({
        tripId: "",
        title: "Hôtel Rome",
        currency: "EUR",
        status: "pending",
        attachments: [],
        userId: USER_ID,
        createdAt: NOW,
        _id: "new-booking",
      });
    });

    it("should parse the price as a number when it is provided as a string", async () => {
      // Act
      const { booking } = await bookingService.createBooking(
        { type: "hotel", title: "Hôtel", date: "2026-07-01", price: "129.90" },
        USER_ID
      );

      // Assert
      expect(booking.price).toBe(129.9);
    });
  });

  describe("updateBooking", () => {
    it("should return a 404 error when the booking does not exist", async () => {
      // Arrange
      mockFakeDb.col("bookings").findOne.mockResolvedValue(null);

      // Act
      const result = await bookingService.updateBooking(BOOKING_ID, { title: "X" }, USER_ID);

      // Assert
      expect(result).toEqual({ error: "Réservation introuvable", status: 404 });
    });

    it("should return a 403 error when the collaborator has no edit permission", async () => {
      // Arrange
      mockFakeDb.col("bookings").findOne.mockResolvedValue({
        _id: BOOKING_ID,
        userId: USER_ID,
        tripId: TRIP_ID,
      });
      mockFakeDb.col("trips").findOne.mockResolvedValue(
        buildTrip({ collaborators: [{ userId: OTHER_ID, permissions: { canEdit: false } }] })
      );

      // Act
      const result = await bookingService.updateBooking(BOOKING_ID, { title: "X" }, OTHER_ID);

      // Assert
      expect(result).toEqual({ error: "Accès refusé", status: 403 });
    });

    it("should ignore fields outside the allowlist", async () => {
      // Arrange
      mockFakeDb.col("bookings").findOne.mockResolvedValue({ _id: BOOKING_ID, userId: USER_ID });

      // Act
      await bookingService.updateBooking(
        BOOKING_ID,
        { title: "Nouveau titre", userId: "hacker", _id: "spoofed" },
        USER_ID
      );

      // Assert
      expect(mockFakeDb.col("bookings").updateOne).toHaveBeenCalledWith(
        { _id: new ObjectId(BOOKING_ID) },
        { $set: { updatedAt: NOW, title: "Nouveau titre" } }
      );
    });

    it("should allow a collaborator holding the canEdit permission", async () => {
      // Arrange
      mockFakeDb.col("bookings").findOne.mockResolvedValue({
        _id: BOOKING_ID,
        userId: "someone-else",
        tripId: TRIP_ID,
      });
      mockFakeDb.col("trips").findOne.mockResolvedValue(
        buildTrip({
          ownerId: "someone-else",
          collaborators: [{ userId: OTHER_ID, permissions: { canEdit: true } }],
        })
      );

      // Act
      const result = await bookingService.updateBooking(BOOKING_ID, { title: "X" }, OTHER_ID);

      // Assert
      expect(result.error).toBeUndefined();
    });
  });

  describe("deleteBooking", () => {
    it("should return a 404 error when the booking does not exist", async () => {
      // Arrange
      mockFakeDb.col("bookings").findOne.mockResolvedValue(null);

      // Act
      const result = await bookingService.deleteBooking(BOOKING_ID, USER_ID);

      // Assert
      expect(result).toEqual({ error: "Réservation introuvable", status: 404 });
    });

    it("should return a 403 error when the booking belongs to an inaccessible trip", async () => {
      // Arrange
      mockFakeDb.col("bookings").findOne.mockResolvedValue({
        _id: BOOKING_ID,
        userId: "someone-else",
        tripId: TRIP_ID,
      });
      mockFakeDb.col("trips").findOne.mockResolvedValue(null);

      // Act
      const result = await bookingService.deleteBooking(BOOKING_ID, USER_ID);

      // Assert
      expect(result).toEqual({ error: "Accès refusé", status: 403 });
    });

    it("should delete the booking when the user created it", async () => {
      // Arrange
      mockFakeDb.col("bookings").findOne.mockResolvedValue({ _id: BOOKING_ID, userId: USER_ID });

      // Act
      const result = await bookingService.deleteBooking(BOOKING_ID, USER_ID);

      // Assert
      expect(result).toEqual({ success: true });
      expect(mockFakeDb.col("bookings").deleteOne).toHaveBeenCalledWith({
        _id: new ObjectId(BOOKING_ID),
      });
    });
  });
});
