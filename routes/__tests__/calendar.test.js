const request = require("supertest");
const { ObjectId } = require("mongodb");
const { createFakeDb, mockFind } = require("../../__tests__/helpers/fakeDb");
const { createApp, silenceConsole } = require("../../__tests__/helpers/routerApp");

const USER_ID = "507f1f77bcf86cd799439011";
const TOKEN = "a".repeat(64);

// Préfixe `mock` obligatoire : la factory de jest.mock est hoistée au-dessus des require.
const mockFakeDb = createFakeDb();
jest.mock("../../db", () => ({ getDb: () => mockFakeDb.db }));

const calendarRouter = require("../calendar");

const premiumSubscription = () => ({
  status: "active",
  endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
});

describe("calendar router", () => {
  let app;
  let restoreConsole;

  beforeAll(() => {
    app = createApp("/calendar", calendarRouter);
    restoreConsole = silenceConsole();
  });

  afterAll(() => restoreConsole());

  beforeEach(() => mockFakeDb.reset());

  it("should return 404 when the token is not a 64-character hexadecimal string", async () => {
    // Act
    const res = await request(app).get("/calendar/pas-un-token");

    // Assert
    expect(res.status).toBe(404);
  });

  it("should return 404 when no user owns the token", async () => {
    // Arrange
    mockFakeDb.col("users").findOne.mockResolvedValue(null);

    // Act
    const res = await request(app).get(`/calendar/${TOKEN}`);

    // Assert
    expect(res.status).toBe(404);
  });

  it("should return 403 when the user has no subscription", async () => {
    // Arrange
    mockFakeDb.col("users").findOne.mockResolvedValue({ _id: new ObjectId(USER_ID) });
    mockFakeDb.col("subscriptions").findOne.mockResolvedValue(null);

    // Act
    const res = await request(app).get(`/calendar/${TOKEN}`);

    // Assert
    expect(res.status).toBe(403);
  });

  it("should return 403 when the premium subscription has expired", async () => {
    // Arrange
    mockFakeDb.col("users").findOne.mockResolvedValue({ _id: new ObjectId(USER_ID) });
    mockFakeDb.col("subscriptions").findOne.mockResolvedValue({
      status: "active",
      endDate: new Date(Date.now() - 1000),
    });

    // Act
    const res = await request(app).get(`/calendar/${TOKEN}`);

    // Assert
    expect(res.status).toBe(403);
  });

  it("should serve an iCal feed as a downloadable attachment for a premium user", async () => {
    // Arrange
    mockFakeDb.col("users").findOne.mockResolvedValue({ _id: new ObjectId(USER_ID) });
    mockFakeDb.col("subscriptions").findOne.mockResolvedValue(premiumSubscription());
    mockFind(mockFakeDb.col("trips"), []);
    mockFind(mockFakeDb.col("bookings"), []);

    // Act
    const res = await request(app).get(`/calendar/${TOKEN}`);

    // Assert
    expect(res.headers["content-type"]).toBe("text/calendar; charset=utf-8");
    expect(res.headers["content-disposition"]).toBe('attachment; filename="mytripcircle.ics"');
    expect(res.text).toContain("BEGIN:VCALENDAR");
  });

  it("should describe an event with its trip, confirmation number and description", async () => {
    // Arrange
    const tripId = new ObjectId();
    mockFakeDb.col("users").findOne.mockResolvedValue({ _id: new ObjectId(USER_ID) });
    mockFakeDb.col("subscriptions").findOne.mockResolvedValue(premiumSubscription());
    mockFind(mockFakeDb.col("trips"), [{ _id: tripId, title: "Rome" }]);
    mockFind(mockFakeDb.col("bookings"), [
      {
        _id: "booking-1",
        tripId: String(tripId),
        title: "Hôtel",
        date: "2026-07-01T10:00:00.000Z",
        endDate: "2026-07-01T12:00:00.000Z",
        confirmationNumber: "ABC123",
        description: "Chambre double",
        address: "1 via Roma",
      },
    ]);

    // Act
    const res = await request(app).get(`/calendar/${TOKEN}`);

    // Assert
    expect(res.text).toContain("SUMMARY:Hôtel");
    expect(res.text).toContain("Voyage : Rome");
    expect(res.text).toContain("N° confirmation : ABC123");
    expect(res.text).toContain("LOCATION:1 via Roma");
  });

  it("should skip bookings that carry no date", async () => {
    // Arrange
    mockFakeDb.col("users").findOne.mockResolvedValue({ _id: new ObjectId(USER_ID) });
    mockFakeDb.col("subscriptions").findOne.mockResolvedValue(premiumSubscription());
    mockFind(mockFakeDb.col("trips"), []);
    mockFind(mockFakeDb.col("bookings"), [{ _id: "booking-1", title: "Sans date" }]);

    // Act
    const res = await request(app).get(`/calendar/${TOKEN}`);

    // Assert
    expect(res.text).not.toContain("BEGIN:VEVENT");
  });

  it("should fall back on the booking type as summary and end the event one hour later", async () => {
    // Arrange
    mockFakeDb.col("users").findOne.mockResolvedValue({ _id: new ObjectId(USER_ID) });
    mockFakeDb.col("subscriptions").findOne.mockResolvedValue(premiumSubscription());
    mockFind(mockFakeDb.col("trips"), []);
    mockFind(mockFakeDb.col("bookings"), [
      { _id: "booking-1", type: "transport", date: "2026-07-01T10:00:00.000Z" },
    ]);

    // Act
    const res = await request(app).get(`/calendar/${TOKEN}`);

    // Assert
    expect(res.text).toContain("SUMMARY:transport");
    expect(res.text).toContain("DTSTART:20260701T100000Z");
    expect(res.text).toContain("DTEND:20260701T110000Z");
  });

  it("should return 500 when the database fails", async () => {
    // Arrange
    mockFakeDb.col("users").findOne.mockRejectedValue(new Error("mongo down"));

    // Act
    const res = await request(app).get(`/calendar/${TOKEN}`);

    // Assert
    expect(res.status).toBe(500);
  });
});
