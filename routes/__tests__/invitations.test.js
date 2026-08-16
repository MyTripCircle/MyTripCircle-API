const request = require("supertest");
const { ObjectId } = require("mongodb");
const { createFakeDb, mockFind } = require("../../__tests__/helpers/fakeDb");
const { createApp, silenceConsole } = require("../../__tests__/helpers/routerApp");

const USER_ID = "507f1f77bcf86cd799439011";
const TRIP_ID = "507f1f77bcf86cd799439022";
const INVITATION_ID = "507f1f77bcf86cd799439033";

// Préfixe `mock` obligatoire : la factory de jest.mock est hoistée au-dessus des require.
const mockFakeDb = createFakeDb();
jest.mock("../../db", () => ({ getDb: () => mockFakeDb.db }));

let mockCurrentUser;
jest.mock("../../middleware/auth", () => ({
  requireAuth: (req, _res, next) => {
    req.user = mockCurrentUser;
    next();
  },
}));

jest.mock("../../utils/email", () => ({ sendTripInvitationEmail: jest.fn() }));

const { sendTripInvitationEmail } = require("../../utils/email");
const { encrypt, hashField } = require("../../utils/crypto");
const { API_BASE_URL } = require("../../config");
const invitationsRouter = require("../invitations");

const buildTrip = (overrides = {}) => ({
  _id: new ObjectId(TRIP_ID),
  title: "Rome",
  destination: "Italie",
  ownerId: USER_ID,
  collaborators: [],
  ...overrides,
});

describe("invitations router", () => {
  let app;
  let restoreConsole;

  beforeAll(() => {
    app = createApp("/invitations", invitationsRouter);
    restoreConsole = silenceConsole();
  });

  afterAll(() => restoreConsole());

  beforeEach(() => {
    mockFakeDb.reset();
    jest.clearAllMocks();
    mockCurrentUser = {
      _id: USER_ID,
      email: "alice@test.com",
      emailHash: hashField("alice@test.com"),
    };
  });

  describe("POST /invitations", () => {
    it("should return 400 when neither an email nor a phone is provided", async () => {
      // Act
      const res = await request(app).post("/invitations").send({ tripId: TRIP_ID });

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Email ou numéro de téléphone requis");
    });

    it("should return 404 when the trip does not exist", async () => {
      // Arrange
      mockFakeDb.col("trips").findOne.mockResolvedValue(null);

      // Act
      const res = await request(app)
        .post("/invitations")
        .send({ tripId: TRIP_ID, inviteeEmail: "bob@test.com" });

      // Assert
      expect(res.status).toBe(404);
    });

    it("should return 403 when the inviter has no invite permission", async () => {
      // Arrange
      mockFakeDb.col("trips").findOne.mockResolvedValue(
        buildTrip({ ownerId: "someone-else", collaborators: [{ userId: USER_ID, permissions: { canInvite: false } }] })
      );

      // Act
      const res = await request(app)
        .post("/invitations")
        .send({ tripId: TRIP_ID, inviteeEmail: "bob@test.com" });

      // Assert
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("Non autorisé à inviter");
    });

    it("should return 403 when the free collaborator quota is reached", async () => {
      // Arrange
      mockFakeDb.col("trips").findOne.mockResolvedValue(
        buildTrip({ collaborators: [{ userId: "a" }, { userId: "b" }] })
      );
      mockFakeDb.col("subscriptions").findOne.mockResolvedValue(null);

      // Act
      const res = await request(app)
        .post("/invitations")
        .send({ tripId: TRIP_ID, inviteeEmail: "bob@test.com" });

      // Assert
      expect(res.status).toBe(403);
      expect(res.body.error).toContain("Limite de 2 collaborateurs atteinte");
    });

    it("should return 400 when the invitee is already a collaborator", async () => {
      // Arrange
      mockFakeDb.col("trips").findOne.mockResolvedValue(
        buildTrip({ collaborators: [{ userId: "bob", email: "bob@test.com" }] })
      );
      mockFakeDb.col("subscriptions").findOne.mockResolvedValue({
        status: "active",
        features: { maxCollaborators: -1 },
      });

      // Act
      const res = await request(app)
        .post("/invitations")
        .send({ tripId: TRIP_ID, inviteeEmail: "bob@test.com" });

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Utilisateur déjà collaborateur");
    });

    it("should return 400 when an invitation is already pending", async () => {
      // Arrange
      mockFakeDb.col("trips").findOne.mockResolvedValue(buildTrip());
      mockFakeDb.col("subscriptions").findOne.mockResolvedValue(null);
      mockFakeDb.col("invitations").findOne.mockResolvedValue({ _id: INVITATION_ID });

      // Act
      const res = await request(app)
        .post("/invitations")
        .send({ tripId: TRIP_ID, inviteeEmail: "bob@test.com" });

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invitation déjà en attente");
    });

    it("should create an encrypted invitation and email the invitee", async () => {
      // Arrange
      mockFakeDb.col("trips").findOne.mockResolvedValue(buildTrip());
      mockFakeDb.col("subscriptions").findOne.mockResolvedValue(null);
      mockFakeDb.col("invitations").findOne.mockResolvedValue(null);
      mockFakeDb.col("users").findOne.mockResolvedValue({
        _id: new ObjectId(USER_ID),
        name: encrypt("Alice"),
      });

      // Act
      const res = await request(app)
        .post("/invitations")
        .send({ tripId: TRIP_ID, inviteeEmail: "bob@test.com", message: "Rejoins-nous" });

      // Assert
      expect(res.status).toBe(201);
      expect(res.body.inviteeEmail).not.toBe("bob@test.com");
      expect(res.body.permissions).toEqual({
        role: "editor",
        canEdit: true,
        canInvite: false,
        canDelete: false,
      });
      expect(sendTripInvitationEmail).toHaveBeenCalledWith(
        "bob@test.com",
        expect.objectContaining({ inviterName: "Alice", tripTitle: "Rome" }),
        "fr"
      );
    });

    it("should skip the email when the invitation targets a phone number", async () => {
      // Arrange
      mockFakeDb.col("trips").findOne.mockResolvedValue(buildTrip());
      mockFakeDb.col("subscriptions").findOne.mockResolvedValue(null);
      mockFakeDb.col("invitations").findOne.mockResolvedValue(null);

      // Act
      const res = await request(app)
        .post("/invitations")
        .send({ tripId: TRIP_ID, inviteePhone: "+33612345678" });

      // Assert
      expect(res.status).toBe(201);
      expect(sendTripInvitationEmail).not.toHaveBeenCalled();
    });

    it("should return 500 when the database fails", async () => {
      // Arrange
      mockFakeDb.col("trips").findOne.mockRejectedValue(new Error("mongo down"));

      // Act
      const res = await request(app)
        .post("/invitations")
        .send({ tripId: TRIP_ID, inviteeEmail: "bob@test.com" });

      // Assert
      expect(res.status).toBe(500);
    });
  });

  describe("GET /invitations/user/:email", () => {
    it("should return 403 when the caller asks for someone else invitations", async () => {
      // Act
      const res = await request(app).get("/invitations/user/bob@test.com");

      // Assert
      expect(res.status).toBe(403);
    });

    it("should enrich each invitation with its trip and inviter", async () => {
      // Arrange
      mockFind(mockFakeDb.col("invitations"), [
        { _id: INVITATION_ID, tripId: TRIP_ID, inviterId: USER_ID },
      ]);
      mockFakeDb.col("trips").findOne.mockResolvedValue(buildTrip());
      mockFakeDb.col("users").findOne.mockResolvedValue({
        _id: new ObjectId(USER_ID),
        name: encrypt("Alice"),
        email: encrypt("alice@test.com"),
      });

      // Act
      const res = await request(app).get("/invitations/user/Alice@test.com?status=pending");

      // Assert
      expect(res.body[0].trip.title).toBe("Rome");
      expect(res.body[0].inviter.name).toBe("Alice");
    });

    it("should keep a null trip and inviter when they no longer exist", async () => {
      // Arrange
      mockFind(mockFakeDb.col("invitations"), [
        { _id: INVITATION_ID, tripId: TRIP_ID, inviterId: USER_ID },
      ]);
      mockFakeDb.col("trips").findOne.mockResolvedValue(null);
      mockFakeDb.col("users").findOne.mockResolvedValue(null);

      // Act
      const res = await request(app).get("/invitations/user/alice@test.com");

      // Assert
      expect(res.body[0]).toMatchObject({ trip: null, inviter: null });
    });

    it("should return 500 when the database fails", async () => {
      // Arrange
      mockFakeDb.col("invitations").find.mockImplementation(() => {
        throw new Error("mongo down");
      });

      // Act
      const res = await request(app).get("/invitations/user/alice@test.com");

      // Assert
      expect(res.status).toBe(500);
    });
  });

  describe("GET /invitations/token/:token", () => {
    it("should return 404 when the token matches no invitation", async () => {
      // Arrange
      mockFakeDb.col("invitations").findOne.mockResolvedValue(null);

      // Act
      const res = await request(app).get("/invitations/token/abc");

      // Assert
      expect(res.status).toBe(404);
    });

    it("should return the invitation together with its trip and inviter", async () => {
      // Arrange
      mockFakeDb.col("invitations").findOne.mockResolvedValue({
        _id: INVITATION_ID,
        tripId: TRIP_ID,
        inviterId: USER_ID,
      });
      mockFakeDb.col("trips").findOne.mockResolvedValue(buildTrip({ coverImage: "cover.png" }));
      mockFakeDb.col("users").findOne.mockResolvedValue({
        _id: new ObjectId(USER_ID),
        name: encrypt("Alice"),
      });

      // Act
      const res = await request(app).get("/invitations/token/abc");

      // Assert
      expect(res.body.trip.coverImage).toBe("cover.png");
      expect(res.body.inviter.name).toBe("Alice");
    });

    it("should return 500 when the database fails", async () => {
      // Arrange
      mockFakeDb.col("invitations").findOne.mockRejectedValue(new Error("mongo down"));

      // Act
      const res = await request(app).get("/invitations/token/abc");

      // Assert
      expect(res.status).toBe(500);
    });
  });

  describe("GET /invitations/sent", () => {
    it("should enrich the sent invitations with their trip", async () => {
      // Arrange
      mockFind(mockFakeDb.col("invitations"), [{ _id: INVITATION_ID, tripId: TRIP_ID }]);
      mockFakeDb.col("trips").findOne.mockResolvedValue(buildTrip());

      // Act
      const res = await request(app).get("/invitations/sent?status=pending");

      // Assert
      expect(res.body[0].trip.destination).toBe("Italie");
    });

    it("should return 500 when the database fails", async () => {
      // Arrange
      mockFakeDb.col("invitations").find.mockImplementation(() => {
        throw new Error("mongo down");
      });

      // Act
      const res = await request(app).get("/invitations/sent");

      // Assert
      expect(res.status).toBe(500);
    });
  });

  describe("POST /invitations/trip-link/:tripId", () => {
    it("should return 404 when the trip does not exist", async () => {
      // Arrange
      mockFakeDb.col("trips").findOne.mockResolvedValue(null);

      // Act
      const res = await request(app).post(`/invitations/trip-link/${TRIP_ID}`).send({});

      // Assert
      expect(res.status).toBe(404);
    });

    it("should return 403 when the caller cannot invite on this trip", async () => {
      // Arrange
      mockFakeDb.col("trips").findOne.mockResolvedValue(buildTrip({ ownerId: "someone-else" }));

      // Act
      const res = await request(app).post(`/invitations/trip-link/${TRIP_ID}`).send({});

      // Assert
      expect(res.status).toBe(403);
    });

    it("should reuse the existing link when one already exists", async () => {
      // Arrange
      mockFakeDb.col("trips").findOne.mockResolvedValue(buildTrip());
      mockFakeDb.col("invitations").findOne.mockResolvedValue({ token: "token-existant" });

      // Act
      const res = await request(app).post(`/invitations/trip-link/${TRIP_ID}`).send({});

      // Assert
      expect(res.body).toEqual({
        token: "token-existant",
        link: `${API_BASE_URL}/join/token-existant`,
      });
      expect(mockFakeDb.col("invitations").insertOne).not.toHaveBeenCalled();
    });

    it("should regenerate the link when force is requested", async () => {
      // Arrange
      mockFakeDb.col("trips").findOne.mockResolvedValue(buildTrip());

      // Act
      const res = await request(app)
        .post(`/invitations/trip-link/${TRIP_ID}`)
        .send({ force: true });

      // Assert
      expect(res.status).toBe(201);
      expect(res.body.token).toMatch(/^[0-9a-f]{64}$/);
      expect(mockFakeDb.col("invitations").deleteMany).toHaveBeenCalledWith({
        tripId: TRIP_ID,
        inviterId: USER_ID,
        type: "link",
      });
    });

    it("should return 500 when the database fails", async () => {
      // Arrange
      mockFakeDb.col("trips").findOne.mockRejectedValue(new Error("mongo down"));

      // Act
      const res = await request(app).post(`/invitations/trip-link/${TRIP_ID}`).send({});

      // Assert
      expect(res.status).toBe(500);
    });
  });

  describe("PUT /invitations/:token", () => {
    const FUTURE = () => new Date(Date.now() + 60 * 1000);
    const PAST = () => new Date(Date.now() - 60 * 1000);

    it("should return 400 when the action is neither accept nor decline", async () => {
      // Act
      const res = await request(app).put("/invitations/abc").send({ action: "peut-être" });

      // Assert
      expect(res.status).toBe(400);
    });

    it("should return 404 when the token matches no invitation", async () => {
      // Arrange
      mockFakeDb.col("invitations").findOne.mockResolvedValue(null);

      // Act
      const res = await request(app).put("/invitations/abc").send({ action: "accept" });

      // Assert
      expect(res.status).toBe(404);
    });

    it("should decline a link invitation without touching the trip", async () => {
      // Arrange
      mockFakeDb.col("invitations").findOne.mockResolvedValue({ type: "link" });

      // Act
      const res = await request(app).put("/invitations/abc").send({ action: "decline" });

      // Assert
      expect(res.body).toEqual({ success: true, status: "declined" });
      expect(mockFakeDb.col("trips").updateOne).not.toHaveBeenCalled();
    });

    it("should return 400 when the link invitation has expired", async () => {
      // Arrange
      mockFakeDb.col("invitations").findOne.mockResolvedValue({ type: "link", expiresAt: PAST() });

      // Act
      const res = await request(app).put("/invitations/abc").send({ action: "accept" });

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Ce lien d'invitation a expiré");
    });

    it("should return 404 when the trip behind the link no longer exists", async () => {
      // Arrange
      mockFakeDb.col("invitations").findOne.mockResolvedValue({ type: "link", expiresAt: FUTURE() });
      mockFakeDb.col("trips").findOne.mockResolvedValue(null);

      // Act
      const res = await request(app).put("/invitations/abc").send({ action: "accept" });

      // Assert
      expect(res.status).toBe(404);
    });

    it("should be idempotent when the user is already a member of the trip", async () => {
      // Arrange
      mockFakeDb.col("invitations").findOne.mockResolvedValue({ type: "link", expiresAt: FUTURE() });
      mockFakeDb.col("trips").findOne.mockResolvedValue(buildTrip());

      // Act
      const res = await request(app).put("/invitations/abc").send({ action: "accept" });

      // Assert
      expect(res.body).toEqual({ success: true, status: "accepted", message: "Déjà membre" });
      expect(mockFakeDb.col("trips").updateOne).not.toHaveBeenCalled();
    });

    it("should add the user as collaborator and count the link usage", async () => {
      // Arrange
      mockFakeDb.col("invitations").findOne.mockResolvedValue({
        _id: INVITATION_ID,
        type: "link",
        tripId: TRIP_ID,
        inviterId: "someone-else",
        expiresAt: FUTURE(),
      });
      mockFakeDb.col("trips").findOne.mockResolvedValue(buildTrip({ ownerId: "someone-else" }));

      // Act
      const res = await request(app).put("/invitations/abc").send({ action: "accept" });

      // Assert
      expect(res.body).toEqual({ success: true, status: "accepted" });
      expect(mockFakeDb.col("invitations").updateOne).toHaveBeenCalledWith(
        { _id: INVITATION_ID },
        { $inc: { usageCount: 1 } }
      );
      const [, update] = mockFakeDb.col("trips").updateOne.mock.calls[0];
      expect(update.$push.collaborators.userId).toBe(USER_ID);
    });

    it("should expire a direct invitation whose deadline has passed", async () => {
      // Arrange
      mockFakeDb.col("invitations").findOne.mockResolvedValue({
        _id: INVITATION_ID,
        expiresAt: PAST(),
        status: "pending",
      });

      // Act
      const res = await request(app).put("/invitations/abc").send({ action: "accept" });

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invitation expirée");
      expect(mockFakeDb.col("invitations").updateOne).toHaveBeenCalledWith(
        { _id: INVITATION_ID },
        { $set: { status: "expired" } }
      );
    });

    it("should return 400 when the direct invitation was already processed", async () => {
      // Arrange
      mockFakeDb.col("invitations").findOne.mockResolvedValue({
        _id: INVITATION_ID,
        expiresAt: FUTURE(),
        status: "accepted",
      });

      // Act
      const res = await request(app).put("/invitations/abc").send({ action: "accept" });

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invitation déjà traitée");
    });

    it("should return 403 when the direct invitation targets another identity", async () => {
      // Arrange
      mockFakeDb.col("invitations").findOne.mockResolvedValue({
        _id: INVITATION_ID,
        expiresAt: FUTURE(),
        status: "pending",
        inviteeEmailHash: hashField("bob@test.com"),
      });

      // Act
      const res = await request(app).put("/invitations/abc").send({ action: "accept" });

      // Assert
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("Cette invitation ne vous est pas destinée");
    });

    it("should add the collaborator when the direct invitation matches the caller email", async () => {
      // Arrange
      mockFakeDb.col("invitations").findOne.mockResolvedValue({
        _id: INVITATION_ID,
        tripId: TRIP_ID,
        inviterId: "someone-else",
        expiresAt: FUTURE(),
        status: "pending",
        inviteeEmailHash: hashField("alice@test.com"),
        permissions: { role: "viewer", canEdit: false, canInvite: false, canDelete: false },
      });

      // Act
      const res = await request(app).put("/invitations/abc").send({ action: "accept" });

      // Assert
      expect(res.body).toEqual({ success: true, status: "accepted" });
      const [, update] = mockFakeDb.col("trips").updateOne.mock.calls[0];
      expect(update.$push.collaborators.role).toBe("viewer");
    });

    it("should only flag the invitation as declined when it is refused", async () => {
      // Arrange
      mockFakeDb.col("invitations").findOne.mockResolvedValue({
        _id: INVITATION_ID,
        expiresAt: FUTURE(),
        status: "pending",
        inviteeEmailHash: hashField("alice@test.com"),
      });

      // Act
      const res = await request(app).put("/invitations/abc").send({ action: "decline" });

      // Assert
      expect(res.body).toEqual({ success: true, status: "declined" });
      expect(mockFakeDb.col("trips").updateOne).not.toHaveBeenCalled();
    });

    it("should return 500 when the database fails", async () => {
      // Arrange
      mockFakeDb.col("invitations").findOne.mockRejectedValue(new Error("mongo down"));

      // Act
      const res = await request(app).put("/invitations/abc").send({ action: "accept" });

      // Assert
      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Erreur interne du serveur");
    });
  });

  describe("DELETE /invitations/:id", () => {
    it("should return 404 when the identifier is malformed", async () => {
      // Act
      const res = await request(app).delete("/invitations/pas-un-id");

      // Assert
      expect(res.status).toBe(404);
    });

    it("should return 403 when the invitation belongs to another inviter", async () => {
      // Arrange
      mockFakeDb.col("invitations").findOne.mockResolvedValue({ inviterId: "someone-else" });

      // Act
      const res = await request(app).delete(`/invitations/${INVITATION_ID}`);

      // Assert
      expect(res.status).toBe(403);
    });

    it("should delete the invitation of its own inviter", async () => {
      // Arrange
      mockFakeDb.col("invitations").findOne.mockResolvedValue({ inviterId: USER_ID });

      // Act
      const res = await request(app).delete(`/invitations/${INVITATION_ID}`);

      // Assert
      expect(res.body).toEqual({ success: true });
      expect(mockFakeDb.col("invitations").deleteOne).toHaveBeenCalledWith({
        _id: new ObjectId(INVITATION_ID),
      });
    });

    it("should return 500 when the deletion fails", async () => {
      // Arrange
      mockFakeDb.col("invitations").findOne.mockResolvedValue({ inviterId: USER_ID });
      mockFakeDb.col("invitations").deleteOne.mockRejectedValue(new Error("mongo down"));

      // Act
      const res = await request(app).delete(`/invitations/${INVITATION_ID}`);

      // Assert
      expect(res.status).toBe(500);
    });
  });

  describe("GET /invitations/join/:token", () => {
    it("should serve an error page when the token is unknown", async () => {
      // Arrange
      mockFakeDb.col("invitations").findOne.mockResolvedValue(null);

      // Act
      const res = await request(app).get("/invitations/join/abc");

      // Assert
      expect(res.status).toBe(404);
      expect(res.text).toContain("Lien invalide ou expiré");
    });

    it("should redirect to the application deep link when the token exists", async () => {
      // Arrange
      mockFakeDb.col("invitations").findOne.mockResolvedValue({ token: "abc" });

      // Act
      const res = await request(app).get("/invitations/join/abc");

      // Assert
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("mytripcircle://invitation/abc");
    });

    it("should return 500 when the database fails", async () => {
      // Arrange
      mockFakeDb.col("invitations").findOne.mockRejectedValue(new Error("mongo down"));

      // Act
      const res = await request(app).get("/invitations/join/abc");

      // Assert
      expect(res.status).toBe(500);
    });
  });
});
