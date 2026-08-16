const { ObjectId } = require("mongodb");
const { createFakeDb, mockFind } = require("../../__tests__/helpers/fakeDb");

// Préfixe `mock` obligatoire : la factory de jest.mock est hoistée au-dessus des require.
const mockFakeDb = createFakeDb();
jest.mock("../../db", () => ({ getDb: () => mockFakeDb.db }));

const addressService = require("../addressService");
// Chiffrement réel (clés de test fournies par setupEnv) : on vérifie ainsi que les
// champs sensibles sont bien chiffrés à l'écriture et déchiffrés à la lecture.
const { encrypt, encryptAddressFields } = require("../../utils/crypto");

const ADDRESS_ID = "507f1f77bcf86cd799439011";
const TRIP_ID = "507f1f77bcf86cd799439022";
const USER_ID = "user-1";
const OTHER_ID = "other-1";
const NOW = new Date("2026-06-15T10:00:00.000Z");

const validPayload = {
  type: "hotel",
  name: "  Hôtel Rome  ",
  address: "  1 via Roma  ",
  city: "  Rome  ",
  country: "  Italie  ",
};

const buildTrip = (overrides = {}) => ({
  _id: new ObjectId(TRIP_ID),
  ownerId: USER_ID,
  collaborators: [],
  visibility: "private",
  ...overrides,
});

describe("addressService", () => {
  beforeEach(() => {
    mockFakeDb.reset();
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });

  afterEach(() => jest.useRealTimers());

  describe("getAddressesForUser", () => {
    it("should decrypt the sensitive fields of every returned address", async () => {
      // Arrange
      mockFind(mockFakeDb.col("trips"), [{ _id: new ObjectId(TRIP_ID) }]);
      mockFind(mockFakeDb.col("addresses"), [
        encryptAddressFields({ _id: "a1", name: "Hôtel", address: "1 via Roma", city: "Rome" }),
      ]);

      // Act
      const [item] = await addressService.getAddressesForUser(USER_ID);

      // Assert
      expect(item).toMatchObject({ name: "Hôtel", address: "1 via Roma", city: "Rome" });
    });
  });

  describe("getAddressesByTripId", () => {
    it("should return a 404 error when the trip does not exist", async () => {
      // Arrange
      mockFakeDb.col("trips").findOne.mockResolvedValue(null);

      // Act
      const result = await addressService.getAddressesByTripId(TRIP_ID, USER_ID);

      // Assert
      expect(result).toEqual({ error: "Voyage introuvable", status: 404 });
    });

    it("should return a 403 error when the trip is private and the user is a stranger", async () => {
      // Arrange
      mockFakeDb.col("trips").findOne.mockResolvedValue(buildTrip());

      // Act
      const result = await addressService.getAddressesByTripId(TRIP_ID, OTHER_ID);

      // Assert
      expect(result).toEqual({ error: "Accès refusé", status: 403 });
    });

    it("should deny access when visibility is friends and no friendship exists", async () => {
      // Arrange
      mockFakeDb.col("trips").findOne.mockResolvedValue(buildTrip({ visibility: "friends" }));
      mockFakeDb.col("friends").findOne.mockResolvedValue(null);

      // Act
      const result = await addressService.getAddressesByTripId(TRIP_ID, OTHER_ID);

      // Assert
      expect(result).toEqual({ error: "Accès refusé", status: 403 });
    });

    it("should return the addresses when visibility is friends and a friendship exists", async () => {
      // Arrange
      mockFakeDb.col("trips").findOne.mockResolvedValue(buildTrip({ visibility: "friends" }));
      mockFakeDb.col("friends").findOne.mockResolvedValue({ userId: OTHER_ID });
      mockFind(mockFakeDb.col("addresses"), []);

      // Act
      const result = await addressService.getAddressesByTripId(TRIP_ID, OTHER_ID);

      // Assert
      expect(result).toEqual({ items: [] });
    });

    it("should return the addresses of a public trip to any user", async () => {
      // Arrange
      mockFakeDb.col("trips").findOne.mockResolvedValue(buildTrip({ visibility: "public" }));
      mockFind(mockFakeDb.col("addresses"), []);

      // Act
      const result = await addressService.getAddressesByTripId(TRIP_ID, OTHER_ID);

      // Assert
      expect(result).toEqual({ items: [] });
    });
  });

  describe("getAddressById", () => {
    it("should return a 404 error when the address does not exist", async () => {
      // Arrange
      mockFakeDb.col("addresses").findOne.mockResolvedValue(null);

      // Act
      const result = await addressService.getAddressById(ADDRESS_ID, USER_ID);

      // Assert
      expect(result).toEqual({ error: "Adresse introuvable", status: 404 });
    });

    it("should return a 403 error when a standalone address belongs to someone else", async () => {
      // Arrange
      mockFakeDb.col("addresses").findOne.mockResolvedValue({ _id: ADDRESS_ID, userId: OTHER_ID });

      // Act
      const result = await addressService.getAddressById(ADDRESS_ID, USER_ID);

      // Assert
      expect(result).toEqual({ error: "Accès refusé", status: 403 });
    });

    it("should return a 403 error when the user has no access to the parent trip", async () => {
      // Arrange
      mockFakeDb.col("addresses").findOne.mockResolvedValue({
        _id: ADDRESS_ID,
        userId: OTHER_ID,
        tripId: TRIP_ID,
      });
      mockFakeDb.col("trips").findOne.mockResolvedValue(buildTrip({ ownerId: OTHER_ID }));

      // Act
      const result = await addressService.getAddressById(ADDRESS_ID, USER_ID);

      // Assert
      expect(result).toEqual({ error: "Accès refusé", status: 403 });
    });

    it("should decrypt the address when the user owns it", async () => {
      // Arrange
      mockFakeDb.col("addresses").findOne.mockResolvedValue({
        _id: ADDRESS_ID,
        userId: USER_ID,
        name: encrypt("Hôtel Rome"),
      });

      // Act
      const result = await addressService.getAddressById(ADDRESS_ID, USER_ID);

      // Assert
      expect(result.item.name).toBe("Hôtel Rome");
    });
  });

  describe("createAddress — validation", () => {
    it("should reject an unknown type", async () => {
      // Act
      const result = await addressService.createAddress({ ...validPayload, type: "castle" }, USER_ID);

      // Assert
      expect(result).toEqual({
        error: "Type invalide. Valeurs acceptées : hotel, restaurant, activity, transport, other",
        status: 400,
      });
    });

    it("should reject a blank name", async () => {
      // Act
      const result = await addressService.createAddress({ ...validPayload, name: "   " }, USER_ID);

      // Assert
      expect(result).toEqual({ error: "Nom requis (1-200 caractères)", status: 400 });
    });

    it("should reject an address longer than 500 characters", async () => {
      // Act
      const result = await addressService.createAddress(
        { ...validPayload, address: "a".repeat(501) },
        USER_ID
      );

      // Assert
      expect(result).toEqual({ error: "Adresse requise (1-500 caractères)", status: 400 });
    });

    it("should reject a missing city", async () => {
      // Act
      const result = await addressService.createAddress({ ...validPayload, city: "" }, USER_ID);

      // Assert
      expect(result).toEqual({ error: "Ville requise (1-100 caractères)", status: 400 });
    });

    it("should reject a missing country", async () => {
      // Act
      const result = await addressService.createAddress({ ...validPayload, country: "" }, USER_ID);

      // Assert
      expect(result).toEqual({ error: "Pays requis (1-100 caractères)", status: 400 });
    });

    it("should reject a rating outside the 0-5 range", async () => {
      // Act
      const result = await addressService.createAddress({ ...validPayload, rating: 6 }, USER_ID);

      // Assert
      expect(result).toEqual({ error: "Note invalide (0-5)", status: 400 });
    });

    it("should reject a non-http website URL", async () => {
      // Act
      const result = await addressService.createAddress(
        { ...validPayload, website: "javascript:alert(1)" },
        USER_ID
      );

      // Assert
      expect(result).toEqual({ error: "URL du site invalide", status: 400 });
    });

    it("should reject a malformed photo URL", async () => {
      // Act
      const result = await addressService.createAddress(
        { ...validPayload, photoUrl: "pas-une-url" },
        USER_ID
      );

      // Assert
      expect(result).toEqual({ error: "URL de la photo invalide", status: 400 });
    });
  });

  describe("createAddress — persistence", () => {
    it("should trim the fields and return the decrypted address", async () => {
      // Arrange
      mockFakeDb.col("addresses").insertOne.mockResolvedValue({ insertedId: "new-address" });

      // Act
      const { item } = await addressService.createAddress(validPayload, USER_ID);

      // Assert
      expect(item).toMatchObject({
        name: "Hôtel Rome",
        address: "1 via Roma",
        city: "Rome",
        country: "Italie",
        userId: USER_ID,
        createdAt: NOW,
        _id: "new-address",
      });
    });

    it("should encrypt the name and the address before inserting them", async () => {
      // Act
      await addressService.createAddress(validPayload, USER_ID);

      // Assert
      const [inserted] = mockFakeDb.col("addresses").insertOne.mock.calls[0];
      expect(inserted.name).not.toBe("Hôtel Rome");
      expect(inserted.name).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
      expect(inserted.city).toBe("Rome");
    });
  });

  describe("updateAddress", () => {
    it("should return a 404 error when the address does not exist", async () => {
      // Arrange
      mockFakeDb.col("addresses").findOne.mockResolvedValue(null);

      // Act
      const result = await addressService.updateAddress(ADDRESS_ID, { city: "Milan" }, USER_ID);

      // Assert
      expect(result).toEqual({ error: "Adresse introuvable", status: 404 });
    });

    it("should return a 403 error when the user is neither creator nor trip editor", async () => {
      // Arrange
      mockFakeDb.col("addresses").findOne.mockResolvedValue({
        _id: ADDRESS_ID,
        userId: OTHER_ID,
        tripId: TRIP_ID,
      });
      mockFakeDb.col("trips").findOne.mockResolvedValue(
        buildTrip({ ownerId: OTHER_ID, collaborators: [{ userId: USER_ID, permissions: { canEdit: false } }] })
      );

      // Act
      const result = await addressService.updateAddress(ADDRESS_ID, { city: "Milan" }, USER_ID);

      // Assert
      expect(result).toEqual({ error: "Accès refusé", status: 403 });
    });

    it("should return a 400 error when the payload is invalid", async () => {
      // Arrange
      mockFakeDb.col("addresses").findOne.mockResolvedValue({ _id: ADDRESS_ID, userId: USER_ID });

      // Act
      const result = await addressService.updateAddress(ADDRESS_ID, { type: "castle" }, USER_ID);

      // Assert
      expect(result.status).toBe(400);
    });

    it("should unset an optional field when it is explicitly emptied", async () => {
      // Arrange
      mockFakeDb.col("addresses").findOne.mockResolvedValue({ _id: ADDRESS_ID, userId: USER_ID });

      // Act
      await addressService.updateAddress(ADDRESS_ID, { phone: "" }, USER_ID);

      // Assert
      expect(mockFakeDb.col("addresses").updateOne).toHaveBeenCalledWith(
        { _id: new ObjectId(ADDRESS_ID) },
        { $set: { updatedAt: NOW }, $unset: { phone: "" } }
      );
    });

    it("should unset the rating when it is not a number", async () => {
      // Arrange
      mockFakeDb.col("addresses").findOne.mockResolvedValue({ _id: ADDRESS_ID, userId: USER_ID });

      // Act
      await addressService.updateAddress(ADDRESS_ID, { rating: null }, USER_ID);

      // Assert
      const [, payload] = mockFakeDb.col("addresses").updateOne.mock.calls[0];
      expect(payload.$unset).toEqual({ rating: "" });
    });

    it("should encrypt the name when it is updated", async () => {
      // Arrange
      mockFakeDb.col("addresses").findOne.mockResolvedValue({ _id: ADDRESS_ID, userId: USER_ID });

      // Act
      await addressService.updateAddress(ADDRESS_ID, { name: "  Hôtel Milan  " }, USER_ID);

      // Assert
      const [, payload] = mockFakeDb.col("addresses").updateOne.mock.calls[0];
      expect(payload.$set.name).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
    });

    it("should let a trip editor update an address he did not create", async () => {
      // Arrange
      mockFakeDb.col("addresses").findOne.mockResolvedValue({
        _id: ADDRESS_ID,
        userId: OTHER_ID,
        tripId: TRIP_ID,
      });
      mockFakeDb.col("trips").findOne.mockResolvedValue(
        buildTrip({ ownerId: OTHER_ID, collaborators: [{ userId: USER_ID, permissions: { canEdit: true } }] })
      );

      // Act
      const result = await addressService.updateAddress(ADDRESS_ID, { city: "Milan" }, USER_ID);

      // Assert
      expect(result.error).toBeUndefined();
    });
  });

  describe("deleteAddress", () => {
    it("should return a 404 error when the address does not exist", async () => {
      // Arrange
      mockFakeDb.col("addresses").findOne.mockResolvedValue(null);

      // Act
      const result = await addressService.deleteAddress(ADDRESS_ID, USER_ID);

      // Assert
      expect(result).toEqual({ error: "Adresse introuvable", status: 404 });
    });

    it("should return a 403 error when a standalone address belongs to someone else", async () => {
      // Arrange
      mockFakeDb.col("addresses").findOne.mockResolvedValue({ _id: ADDRESS_ID, userId: OTHER_ID });

      // Act
      const result = await addressService.deleteAddress(ADDRESS_ID, USER_ID);

      // Assert
      expect(result).toEqual({ error: "Accès refusé", status: 403 });
    });

    it("should return a 403 error when the collaborator has no delete permission", async () => {
      // Arrange
      mockFakeDb.col("addresses").findOne.mockResolvedValue({
        _id: ADDRESS_ID,
        userId: OTHER_ID,
        tripId: TRIP_ID,
      });
      mockFakeDb.col("trips").findOne.mockResolvedValue(
        buildTrip({ ownerId: OTHER_ID, collaborators: [{ userId: USER_ID, permissions: { canDelete: false } }] })
      );

      // Act
      const result = await addressService.deleteAddress(ADDRESS_ID, USER_ID);

      // Assert
      expect(result).toEqual({ error: "Accès refusé", status: 403 });
    });

    it("should delete the address when the trip owner requests it", async () => {
      // Arrange
      mockFakeDb.col("addresses").findOne.mockResolvedValue({
        _id: ADDRESS_ID,
        userId: OTHER_ID,
        tripId: TRIP_ID,
      });
      mockFakeDb.col("trips").findOne.mockResolvedValue(buildTrip());

      // Act
      const result = await addressService.deleteAddress(ADDRESS_ID, USER_ID);

      // Assert
      expect(result).toEqual({ success: true });
      expect(mockFakeDb.col("addresses").deleteOne).toHaveBeenCalledWith({
        _id: new ObjectId(ADDRESS_ID),
      });
    });
  });
});
