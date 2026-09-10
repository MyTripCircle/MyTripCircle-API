const { ObjectId } = require("mongodb");
const { createFakeDb, mockFind, mockAggregate } = require("../../__tests__/helpers/fakeDb");

// Préfixe `mock` obligatoire : la factory de jest.mock est hoistée au-dessus des require.
const mockFakeDb = createFakeDb();
jest.mock("../../db", () => ({ getDb: () => mockFakeDb.db }));

const tripService = require("../tripService");

const TRIP_ID = "507f1f77bcf86cd799439011";
const OWNER_ID = "owner-1";
const OTHER_ID = "other-1";
const NOW = new Date("2026-06-15T10:00:00.000Z");

const buildTrip = (overrides = {}) => ({
  _id: new ObjectId(TRIP_ID),
  title: "Rome",
  destination: "Italie",
  ownerId: OWNER_ID,
  collaborators: [],
  visibility: "private",
  ...overrides,
});

describe("tripService", () => {
  beforeEach(() => {
    mockFakeDb.reset();
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });

  afterEach(() => jest.useRealTimers());

  describe("getTripsForUser", () => {
    it("should return an empty list when the user owns no trip", async () => {
      // Arrange
      mockFind(mockFakeDb.col("trips"), []);

      // Act
      const result = await tripService.getTripsForUser(OWNER_ID);

      // Assert
      expect(result).toEqual([]);
    });

    it("should enrich each trip with booking, address and collaborator counts", async () => {
      // Arrange
      mockFind(mockFakeDb.col("trips"), [buildTrip({ collaborators: [{ userId: OTHER_ID }] })]);
      mockAggregate(mockFakeDb.col("bookings"), [{ _id: TRIP_ID, count: 3 }]);
      mockAggregate(mockFakeDb.col("addresses"), [{ _id: TRIP_ID, count: 2 }]);

      // Act
      const [trip] = await tripService.getTripsForUser(OWNER_ID);

      // Assert
      expect(trip.stats).toEqual({ totalBookings: 3, totalAddresses: 2, totalCollaborators: 1 });
    });

    it("should default counters to zero when no booking nor address matches", async () => {
      // Arrange
      mockFind(mockFakeDb.col("trips"), [buildTrip()]);

      // Act
      const [trip] = await tripService.getTripsForUser(OWNER_ID);

      // Assert
      expect(trip.stats).toEqual({ totalBookings: 0, totalAddresses: 0, totalCollaborators: 0 });
    });
  });

  describe("getTripById", () => {
    it("should return a 404 error when the trip does not exist", async () => {
      // Arrange
      mockFakeDb.col("trips").findOne.mockResolvedValue(null);

      // Act
      const result = await tripService.getTripById(TRIP_ID, OWNER_ID);

      // Assert
      expect(result).toEqual({ error: "Voyage introuvable", status: 404 });
    });

    it("should return a 403 error when the trip is private and the user is a stranger", async () => {
      // Arrange
      mockFakeDb.col("trips").findOne.mockResolvedValue(buildTrip());

      // Act
      const result = await tripService.getTripById(TRIP_ID, OTHER_ID);

      // Assert
      expect(result).toEqual({ error: "Accès refusé", status: 403 });
    });

    it("should grant access when the user is the owner", async () => {
      // Arrange
      mockFakeDb.col("trips").findOne.mockResolvedValue(buildTrip());

      // Act
      const result = await tripService.getTripById(TRIP_ID, OWNER_ID);

      // Assert
      expect(result.trip.title).toBe("Rome");
    });

    it("should grant access when the user is a collaborator", async () => {
      // Arrange
      mockFakeDb.col("trips").findOne.mockResolvedValue(
        buildTrip({ collaborators: [{ userId: OTHER_ID }] })
      );

      // Act
      const result = await tripService.getTripById(TRIP_ID, OTHER_ID);

      // Assert
      expect(result.error).toBeUndefined();
    });

    it("should grant access to anyone when the trip visibility is public", async () => {
      // Arrange
      mockFakeDb.col("trips").findOne.mockResolvedValue(buildTrip({ visibility: "public" }));

      // Act
      const result = await tripService.getTripById(TRIP_ID, OTHER_ID);

      // Assert
      expect(result.error).toBeUndefined();
    });

    it("should grant access to anyone when a legacy trip only carries the isPublic flag", async () => {
      // Arrange
      mockFakeDb.col("trips").findOne.mockResolvedValue(buildTrip({ visibility: undefined, isPublic: true }));

      // Act
      const result = await tripService.getTripById(TRIP_ID, OTHER_ID);

      // Assert
      expect(result.error).toBeUndefined();
    });

    it("should deny a stranger when visibility is private even though isPublic is still true", async () => {
      // Arrange — divergence décrite par le défaut D-01 : l'ancien OU l'aurait rendu public
      mockFakeDb.col("trips").findOne.mockResolvedValue(buildTrip({ visibility: "private", isPublic: true }));

      // Act
      const result = await tripService.getTripById(TRIP_ID, OTHER_ID);

      // Assert
      expect(result).toEqual({ error: "Accès refusé", status: 403 });
    });

    it("should grant access when visibility is friends and a friendship exists", async () => {
      // Arrange
      mockFakeDb.col("trips").findOne.mockResolvedValue(buildTrip({ visibility: "friends" }));
      mockFakeDb.col("friends").findOne.mockResolvedValue({ userId: OTHER_ID, friendId: OWNER_ID });

      // Act
      const result = await tripService.getTripById(TRIP_ID, OTHER_ID);

      // Assert
      expect(result.error).toBeUndefined();
    });

    it("should deny access when visibility is friends and no friendship exists", async () => {
      // Arrange
      mockFakeDb.col("trips").findOne.mockResolvedValue(buildTrip({ visibility: "friends" }));
      mockFakeDb.col("friends").findOne.mockResolvedValue(null);

      // Act
      const result = await tripService.getTripById(TRIP_ID, OTHER_ID);

      // Assert
      expect(result).toEqual({ error: "Accès refusé", status: 403 });
    });
  });

  describe("createTrip", () => {
    const validPayload = {
      title: "  Rome  ",
      destination: "  Italie  ",
      startDate: "2026-07-01T00:00:00.000Z",
      endDate: "2026-07-10T00:00:00.000Z",
    };

    it("should return a 400 error when a required field is missing", async () => {
      // Act
      const result = await tripService.createTrip({ title: "Rome" }, OWNER_ID);

      // Assert
      expect(result).toEqual({ error: "Champs requis manquants", status: 400 });
    });

    it("should return a 403 error when the free trip quota is reached", async () => {
      // Arrange
      mockFakeDb.col("subscriptions").findOne.mockResolvedValue(null);
      mockFakeDb.col("trips").countDocuments.mockResolvedValue(3);

      // Act
      const result = await tripService.createTrip(validPayload, OWNER_ID);

      // Assert
      expect(result).toEqual({
        error: "Limite de 3 voyages atteinte — passez à Premium pour en créer davantage",
        status: 403,
      });
    });

    it("should skip the quota check when the subscription grants unlimited trips", async () => {
      // Arrange
      mockFakeDb.col("subscriptions").findOne.mockResolvedValue({
        status: "active",
        features: { maxTrips: -1 },
      });
      mockFakeDb.col("trips").insertOne.mockResolvedValue({ insertedId: "new-trip" });

      // Act
      const result = await tripService.createTrip(validPayload, OWNER_ID);

      // Assert
      expect(mockFakeDb.col("trips").countDocuments).not.toHaveBeenCalled();
      expect(result.trip._id).toBe("new-trip");
    });

    it("should return a 400 error when the end date is not after the start date", async () => {
      // Arrange
      mockFakeDb.col("subscriptions").findOne.mockResolvedValue(null);

      // Act
      const result = await tripService.createTrip(
        { ...validPayload, endDate: validPayload.startDate },
        OWNER_ID
      );

      // Assert
      expect(result).toEqual({
        error: "La date de fin doit être après la date de début",
        status: 400,
      });
    });

    it("should return a 400 error when the start date is in the past", async () => {
      // Arrange
      mockFakeDb.col("subscriptions").findOne.mockResolvedValue(null);

      // Act
      const result = await tripService.createTrip(
        { ...validPayload, startDate: "2026-06-01T00:00:00.000Z" },
        OWNER_ID
      );

      // Assert
      expect(result).toEqual({
        error: "La date de début ne peut pas être dans le passé",
        status: 400,
      });
    });

    it("should trim text fields and apply defaults when the payload is valid", async () => {
      // Arrange
      mockFakeDb.col("subscriptions").findOne.mockResolvedValue(null);
      mockFakeDb.col("trips").insertOne.mockResolvedValue({ insertedId: "new-trip" });

      // Act
      const { trip } = await tripService.createTrip(validPayload, OWNER_ID);

      // Assert
      expect(trip).toMatchObject({
        title: "Rome",
        destination: "Italie",
        description: "",
        ownerId: OWNER_ID,
        isPublic: false,
        visibility: "private",
        status: "draft",
        tags: [],
        createdAt: NOW,
      });
    });

    it("should derive a public visibility when isPublic is true and visibility is omitted", async () => {
      // Arrange
      mockFakeDb.col("subscriptions").findOne.mockResolvedValue(null);

      // Act
      const { trip } = await tripService.createTrip({ ...validPayload, isPublic: true }, OWNER_ID);

      // Assert
      expect(trip.visibility).toBe("public");
    });

    it("should derive isPublic from the visibility when only visibility is sent", async () => {
      // Arrange
      mockFakeDb.col("subscriptions").findOne.mockResolvedValue(null);

      // Act
      const { trip } = await tripService.createTrip({ ...validPayload, visibility: "public" }, OWNER_ID);

      // Assert
      expect(trip).toMatchObject({ visibility: "public", isPublic: true });
    });

    it("should return a 400 error when the visibility is not part of the enumeration", async () => {
      // Act
      const result = await tripService.createTrip({ ...validPayload, visibility: "everyone" }, OWNER_ID);

      // Assert
      expect(result).toEqual({ error: "Visibilité invalide", status: 400 });
    });
  });

  describe("updateTrip", () => {
    it("should return a 404 error when the trip does not exist", async () => {
      // Arrange
      mockFakeDb.col("trips").findOne.mockResolvedValue(null);

      // Act
      const result = await tripService.updateTrip(TRIP_ID, { title: "X" }, OWNER_ID);

      // Assert
      expect(result).toEqual({ error: "Voyage introuvable", status: 404 });
    });

    it("should return a 403 error when the collaborator cannot edit", async () => {
      // Arrange
      mockFakeDb.col("trips").findOne.mockResolvedValue(
        buildTrip({ collaborators: [{ userId: OTHER_ID, permissions: { canEdit: false } }] })
      );

      // Act
      const result = await tripService.updateTrip(TRIP_ID, { title: "X" }, OTHER_ID);

      // Assert
      expect(result).toEqual({ error: "Non autorisé à modifier ce voyage", status: 403 });
    });

    it("should return a 400 error when the new end date precedes the new start date", async () => {
      // Arrange
      mockFakeDb.col("trips").findOne.mockResolvedValue(buildTrip());

      // Act
      const result = await tripService.updateTrip(
        TRIP_ID,
        { startDate: "2026-07-10", endDate: "2026-07-01" },
        OWNER_ID
      );

      // Assert
      expect(result).toEqual({
        error: "La date de fin doit être après la date de début",
        status: 400,
      });
    });

    it("should only persist the provided fields, trimmed", async () => {
      // Arrange
      mockFakeDb.col("trips").findOne.mockResolvedValue(buildTrip());

      // Act
      await tripService.updateTrip(TRIP_ID, { title: "  Milan  ", status: "active" }, OWNER_ID);

      // Assert
      expect(mockFakeDb.col("trips").updateOne).toHaveBeenCalledWith(
        { _id: new ObjectId(TRIP_ID) },
        { $set: { updatedAt: NOW, title: "Milan", status: "active" } }
      );
    });

    it("should let an authorised collaborator update the trip", async () => {
      // Arrange
      mockFakeDb.col("trips").findOne.mockResolvedValue(
        buildTrip({ collaborators: [{ userId: OTHER_ID, permissions: { canEdit: true } }] })
      );

      // Act
      const result = await tripService.updateTrip(TRIP_ID, { title: "Milan" }, OTHER_ID);

      // Assert
      expect(result.error).toBeUndefined();
    });

    describe("owner-only decisions (défaut D-23)", () => {
      const editorTrip = (overrides = {}) =>
        buildTrip({
          status: "draft",
          collaborators: [{ userId: OTHER_ID, permissions: { canEdit: true } }],
          ...overrides,
        });
      const OWNER_ONLY = {
        error: "Seul le propriétaire peut valider le voyage ou changer sa visibilité",
        status: 403,
      };

      it("should return a 403 error when an editor tries to validate the trip", async () => {
        // Arrange
        mockFakeDb.col("trips").findOne.mockResolvedValue(editorTrip());

        // Act
        const result = await tripService.updateTrip(TRIP_ID, { status: "validated" }, OTHER_ID);

        // Assert
        expect(result).toEqual(OWNER_ONLY);
        expect(mockFakeDb.col("trips").updateOne).not.toHaveBeenCalled();
      });

      it("should return a 403 error when an editor tries to make the trip public", async () => {
        // Arrange
        mockFakeDb.col("trips").findOne.mockResolvedValue(editorTrip());

        // Act
        const result = await tripService.updateTrip(TRIP_ID, { visibility: "public" }, OTHER_ID);

        // Assert
        expect(result).toEqual(OWNER_ONLY);
      });

      it("should return a 403 error when an editor flips the legacy isPublic flag", async () => {
        // Arrange
        mockFakeDb.col("trips").findOne.mockResolvedValue(editorTrip());

        // Act
        const result = await tripService.updateTrip(TRIP_ID, { isPublic: true }, OTHER_ID);

        // Assert
        expect(result).toEqual(OWNER_ONLY);
      });

      it("should let an editor save the edit form when status and visibility are unchanged", async () => {
        // Arrange — le formulaire renvoie toujours statut et visibilité, même inchangés
        mockFakeDb.col("trips").findOne.mockResolvedValue(editorTrip());

        // Act
        const result = await tripService.updateTrip(
          TRIP_ID,
          { title: "Milan", status: "draft", visibility: "private", isPublic: false },
          OTHER_ID
        );

        // Assert
        expect(result.error).toBeUndefined();
      });

      it("should let the owner validate the trip and change its visibility", async () => {
        // Arrange
        mockFakeDb.col("trips").findOne.mockResolvedValue(editorTrip());

        // Act
        const result = await tripService.updateTrip(
          TRIP_ID,
          { status: "validated", visibility: "friends" },
          OWNER_ID
        );

        // Assert
        expect(result.error).toBeUndefined();
        expect(mockFakeDb.col("trips").updateOne).toHaveBeenCalledWith(
          { _id: new ObjectId(TRIP_ID) },
          { $set: { updatedAt: NOW, status: "validated", visibility: "friends", isPublic: false } }
        );
      });
    });

    describe("single source of truth for visibility (défaut D-01)", () => {
      it("should derive isPublic from visibility so that both fields never diverge", async () => {
        // Arrange
        mockFakeDb.col("trips").findOne.mockResolvedValue(buildTrip({ isPublic: true }));

        // Act — ancien défaut : visibility seule mise à jour, isPublic resté à vrai
        await tripService.updateTrip(TRIP_ID, { visibility: "private" }, OWNER_ID);

        // Assert
        expect(mockFakeDb.col("trips").updateOne).toHaveBeenCalledWith(
          { _id: new ObjectId(TRIP_ID) },
          { $set: { updatedAt: NOW, visibility: "private", isPublic: false } }
        );
      });

      it("should let visibility prevail when the payload carries contradictory fields", async () => {
        // Arrange
        mockFakeDb.col("trips").findOne.mockResolvedValue(buildTrip());

        // Act
        await tripService.updateTrip(TRIP_ID, { visibility: "friends", isPublic: true }, OWNER_ID);

        // Assert
        expect(mockFakeDb.col("trips").updateOne).toHaveBeenCalledWith(
          { _id: new ObjectId(TRIP_ID) },
          { $set: { updatedAt: NOW, visibility: "friends", isPublic: false } }
        );
      });

      it("should derive the visibility when a legacy caller only sends isPublic", async () => {
        // Arrange
        mockFakeDb.col("trips").findOne.mockResolvedValue(buildTrip());

        // Act
        await tripService.updateTrip(TRIP_ID, { isPublic: true }, OWNER_ID);

        // Assert
        expect(mockFakeDb.col("trips").updateOne).toHaveBeenCalledWith(
          { _id: new ObjectId(TRIP_ID) },
          { $set: { updatedAt: NOW, visibility: "public", isPublic: true } }
        );
      });

      it("should return a 400 error when the visibility is not part of the enumeration", async () => {
        // Arrange
        mockFakeDb.col("trips").findOne.mockResolvedValue(buildTrip());

        // Act
        const result = await tripService.updateTrip(TRIP_ID, { visibility: "everyone" }, OWNER_ID);

        // Assert
        expect(result).toEqual({ error: "Visibilité invalide", status: 400 });
      });
    });
  });

  describe("deleteTrip", () => {
    it("should return a 404 error when the trip does not exist", async () => {
      // Arrange
      mockFakeDb.col("trips").findOne.mockResolvedValue(null);

      // Act
      const result = await tripService.deleteTrip(TRIP_ID, OWNER_ID);

      // Assert
      expect(result).toEqual({ error: "Voyage introuvable", status: 404 });
    });

    it("should return a 403 error when the requester is not the owner", async () => {
      // Arrange
      mockFakeDb.col("trips").findOne.mockResolvedValue(buildTrip());

      // Act
      const result = await tripService.deleteTrip(TRIP_ID, OTHER_ID);

      // Assert
      expect(result).toEqual({ error: "Seul le propriétaire peut supprimer ce voyage", status: 403 });
    });

    it("should cascade the deletion to bookings, addresses and invitations", async () => {
      // Arrange
      mockFakeDb.col("trips").findOne.mockResolvedValue(buildTrip());

      // Act
      const result = await tripService.deleteTrip(TRIP_ID, OWNER_ID);

      // Assert
      expect(result).toEqual({ success: true });
      expect(mockFakeDb.col("bookings").deleteMany).toHaveBeenCalledWith({ tripId: TRIP_ID });
      expect(mockFakeDb.col("addresses").deleteMany).toHaveBeenCalledWith({ tripId: TRIP_ID });
      expect(mockFakeDb.col("invitations").deleteMany).toHaveBeenCalledWith({ tripId: TRIP_ID });
    });
  });

  describe("removeTripCollaborator", () => {
    it("should return a 404 error when the trip does not exist", async () => {
      // Arrange
      mockFakeDb.col("trips").findOne.mockResolvedValue(null);

      // Act
      const result = await tripService.removeTripCollaborator(TRIP_ID, OTHER_ID, OWNER_ID);

      // Assert
      expect(result).toEqual({ error: "Voyage introuvable", status: 404 });
    });

    it("should return a 403 error when the requester is not the owner", async () => {
      // Arrange
      mockFakeDb.col("trips").findOne.mockResolvedValue(buildTrip());

      // Act
      const result = await tripService.removeTripCollaborator(TRIP_ID, "someone", OTHER_ID);

      // Assert
      expect(result).toEqual({ error: "Seul le propriétaire peut retirer des membres", status: 403 });
    });

    it("should return a 400 error when the owner targets himself", async () => {
      // Arrange
      mockFakeDb.col("trips").findOne.mockResolvedValue(buildTrip());

      // Act
      const result = await tripService.removeTripCollaborator(TRIP_ID, OWNER_ID, OWNER_ID);

      // Assert
      expect(result).toEqual({ error: "Impossible de se retirer soi-même", status: 400 });
    });

    it("should pull the collaborator from the trip when the owner requests it", async () => {
      // Arrange
      mockFakeDb.col("trips").findOne.mockResolvedValue(buildTrip());

      // Act
      const result = await tripService.removeTripCollaborator(TRIP_ID, OTHER_ID, OWNER_ID);

      // Assert
      expect(result).toEqual({ success: true });
      expect(mockFakeDb.col("trips").updateOne).toHaveBeenCalledWith(
        { _id: new ObjectId(TRIP_ID) },
        { $pull: { collaborators: { userId: OTHER_ID } } }
      );
    });
  });

  describe("transferTripOwnership", () => {
    it("should return a 400 error when newOwnerId is missing", async () => {
      // Act
      const result = await tripService.transferTripOwnership(TRIP_ID, undefined, OWNER_ID);

      // Assert
      expect(result).toEqual({ error: "newOwnerId requis", status: 400 });
    });

    it("should return a 404 error when the trip does not exist", async () => {
      // Arrange
      mockFakeDb.col("trips").findOne.mockResolvedValue(null);

      // Act
      const result = await tripService.transferTripOwnership(TRIP_ID, OTHER_ID, OWNER_ID);

      // Assert
      expect(result).toEqual({ error: "Voyage introuvable", status: 404 });
    });

    it("should return a 403 error when the requester is not the owner", async () => {
      // Arrange
      mockFakeDb.col("trips").findOne.mockResolvedValue(buildTrip());

      // Act
      const result = await tripService.transferTripOwnership(TRIP_ID, "someone", OTHER_ID);

      // Assert
      expect(result).toEqual({
        error: "Seul le propriétaire peut transférer la propriété",
        status: 403,
      });
    });

    it("should return a 400 error when the new owner is not already a member", async () => {
      // Arrange
      mockFakeDb.col("trips").findOne.mockResolvedValue(buildTrip());

      // Act
      const result = await tripService.transferTripOwnership(TRIP_ID, OTHER_ID, OWNER_ID);

      // Assert
      expect(result).toEqual({ error: "Le nouveau propriétaire doit déjà être membre", status: 400 });
    });

    it("should demote the former owner to editor when the transfer succeeds", async () => {
      // Arrange
      mockFakeDb.col("trips").findOne.mockResolvedValue(
        buildTrip({ collaborators: [{ userId: OTHER_ID }] })
      );

      // Act
      const result = await tripService.transferTripOwnership(TRIP_ID, OTHER_ID, OWNER_ID);

      // Assert
      expect(result).toEqual({ success: true });
      expect(mockFakeDb.col("trips").updateOne).toHaveBeenNthCalledWith(
        2,
        { _id: new ObjectId(TRIP_ID) },
        {
          $push: {
            collaborators: {
              userId: OWNER_ID,
              role: "editor",
              joinedAt: NOW,
              permissions: { canEdit: true, canInvite: true, canDelete: false },
            },
          },
        }
      );
    });
  });
});
