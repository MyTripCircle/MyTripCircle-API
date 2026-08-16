const request = require("supertest");
const { ObjectId } = require("mongodb");
const { createFakeDb, mockFind } = require("../../__tests__/helpers/fakeDb");
const { createApp, silenceConsole } = require("../../__tests__/helpers/routerApp");

const USER_ID = "507f1f77bcf86cd799439011";
const RECIPIENT_ID = "507f1f77bcf86cd799439022";
const REQUEST_ID = "507f1f77bcf86cd799439033";

// Préfixe `mock` obligatoire : la factory de jest.mock est hoistée au-dessus des require.
const mockFakeDb = createFakeDb();
jest.mock("../../db", () => ({ getDb: () => mockFakeDb.db }));

jest.mock("../../middleware/auth", () => ({
  requireAuth: (req, _res, next) => {
    req.user = {
      _id: "507f1f77bcf86cd799439011",
      name: "Alice",
      email: "alice@test.com",
      phone: null,
    };
    next();
  },
}));

jest.mock("../../utils/email", () => ({ sendFriendRequestEmail: jest.fn() }));

const { sendFriendRequestEmail } = require("../../utils/email");
const { encrypt } = require("../../utils/crypto");
const friendRequestsRouter = require("../friendRequests");

/** Document utilisateur brut (champs sensibles chiffrés) tel que stocké en base. */
const buildUserDoc = (id, name, email) => ({
  _id: new ObjectId(id),
  name: encrypt(name),
  email: encrypt(email),
});

describe("friendRequests router", () => {
  let app;
  let restoreConsole;

  beforeAll(() => {
    app = createApp("/friends", friendRequestsRouter);
    restoreConsole = silenceConsole();
  });

  afterAll(() => restoreConsole());

  beforeEach(() => {
    mockFakeDb.reset();
    jest.clearAllMocks();
  });

  describe("POST /friends/request", () => {
    it("should return 400 when no recipient identifier is provided", async () => {
      // Act
      const res = await request(app).post("/friends/request").send({});

      // Assert
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "Email, téléphone ou ID requis" });
    });

    it("should return 400 when the sender targets his own id", async () => {
      // Arrange
      mockFakeDb.col("users").findOne.mockResolvedValue(
        buildUserDoc(USER_ID, "Alice", "alice@test.com")
      );

      // Act
      const res = await request(app).post("/friends/request").send({ recipientId: USER_ID });

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Impossible de s'envoyer une demande à soi-même");
    });

    it("should return 400 when the sender targets his own email", async () => {
      // Arrange
      mockFakeDb.col("users").findOne.mockResolvedValue(
        buildUserDoc(USER_ID, "Alice", "alice@test.com")
      );

      // Act
      const res = await request(app)
        .post("/friends/request")
        .send({ recipientEmail: "ALICE@test.com" });

      // Assert
      expect(res.status).toBe(400);
    });

    it("should return 400 when both users are already friends", async () => {
      // Arrange
      mockFakeDb.col("users").findOne
        .mockResolvedValueOnce(buildUserDoc(USER_ID, "Alice", "alice@test.com"))
        .mockResolvedValueOnce(buildUserDoc(RECIPIENT_ID, "Bob", "bob@test.com"));
      mockFakeDb.col("friends").findOne.mockResolvedValue({ userId: USER_ID });

      // Act
      const res = await request(app).post("/friends/request").send({ recipientId: RECIPIENT_ID });

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Déjà amis");
    });

    it("should auto-accept when the recipient already sent a request to the sender", async () => {
      // Arrange
      mockFakeDb.col("users").findOne
        .mockResolvedValueOnce(buildUserDoc(USER_ID, "Alice", "alice@test.com"))
        .mockResolvedValueOnce(buildUserDoc(RECIPIENT_ID, "Bob", "bob@test.com"));
      mockFakeDb.col("friends").findOne.mockResolvedValue(null);
      mockFakeDb.col("friendRequests").findOne.mockResolvedValue({ _id: REQUEST_ID });

      // Act
      const res = await request(app).post("/friends/request").send({ recipientId: RECIPIENT_ID });

      // Assert
      expect(res.body).toEqual({ success: true, autoAccepted: true });
      expect(mockFakeDb.col("friends").insertMany).toHaveBeenCalledTimes(1);
    });

    it("should return 400 when a request is already pending towards a registered user", async () => {
      // Arrange
      mockFakeDb.col("users").findOne
        .mockResolvedValueOnce(buildUserDoc(USER_ID, "Alice", "alice@test.com"))
        .mockResolvedValueOnce(buildUserDoc(RECIPIENT_ID, "Bob", "bob@test.com"));
      mockFakeDb.col("friends").findOne.mockResolvedValue(null);
      mockFakeDb.col("friendRequests").findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ _id: REQUEST_ID });

      // Act
      const res = await request(app).post("/friends/request").send({ recipientId: RECIPIENT_ID });

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Demande déjà en attente");
    });

    it("should notify the recipient when the request targets a registered user", async () => {
      // Arrange
      mockFakeDb.col("users").findOne
        .mockResolvedValueOnce(buildUserDoc(USER_ID, "Alice", "alice@test.com"))
        .mockResolvedValueOnce(buildUserDoc(RECIPIENT_ID, "Bob", "bob@test.com"));
      mockFakeDb.col("friends").findOne.mockResolvedValue(null);
      mockFakeDb.col("friendRequests").findOne.mockResolvedValue(null);

      // Act
      const res = await request(app).post("/friends/request").send({ recipientId: RECIPIENT_ID });

      // Assert
      expect(res.body.recipientId).toBe(RECIPIENT_ID);
      expect(sendFriendRequestEmail).toHaveBeenCalledWith("bob@test.com", "Alice", "fr");
    });

    it("should return 400 when an invitation is already pending for an unregistered email", async () => {
      // Arrange
      mockFakeDb.col("users").findOne.mockResolvedValue(null);
      mockFakeDb.col("friendRequests").findOne.mockResolvedValue({ _id: REQUEST_ID });

      // Act
      const res = await request(app)
        .post("/friends/request")
        .send({ recipientEmail: "inconnu@test.com" });

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Demande déjà en attente");
    });

    it("should store an encrypted invitation without sending an email for an unregistered contact", async () => {
      // Arrange
      mockFakeDb.col("users").findOne.mockResolvedValue(null);
      mockFakeDb.col("friendRequests").findOne.mockResolvedValue(null);

      // Act
      const res = await request(app)
        .post("/friends/request")
        .send({ recipientEmail: "inconnu@test.com", recipientPhone: "+33612345678" });

      // Assert
      expect(res.body.recipientId).toBeNull();
      expect(sendFriendRequestEmail).not.toHaveBeenCalled();
      const [inserted] = mockFakeDb.col("friendRequests").insertOne.mock.calls[0];
      expect(inserted.recipientEmail).not.toBe("inconnu@test.com");
      expect(inserted.recipientEmailHash).toBeDefined();
    });

    it("should return 500 when the database fails", async () => {
      // Arrange
      mockFakeDb.col("users").findOne.mockRejectedValue(new Error("mongo down"));

      // Act
      const res = await request(app).post("/friends/request").send({ recipientId: RECIPIENT_ID });

      // Assert
      expect(res.status).toBe(500);
    });
  });

  describe("GET /friends/requests", () => {
    it("should merge received and sent requests without duplicates", async () => {
      // Arrange
      const sharedId = new ObjectId(REQUEST_ID);
      mockFakeDb.col("friendRequests").find
        .mockReturnValueOnce({ sort: () => ({ toArray: async () => [{ _id: sharedId, senderId: RECIPIENT_ID, recipientId: USER_ID, status: "pending" }] }) })
        .mockReturnValueOnce({ sort: () => ({ toArray: async () => [{ _id: sharedId, senderId: RECIPIENT_ID, recipientId: USER_ID, status: "pending" }] }) });
      mockFind(mockFakeDb.col("friends"), []);

      // Act
      const res = await request(app).get("/friends/requests");

      // Assert
      expect(res.body).toHaveLength(1);
    });

    it("should count the friends shared with each sender", async () => {
      // Arrange
      mockFakeDb.col("friendRequests").find
        .mockReturnValueOnce({ sort: () => ({ toArray: async () => [{ _id: new ObjectId(REQUEST_ID), senderId: RECIPIENT_ID, status: "pending" }] }) })
        .mockReturnValueOnce({ sort: () => ({ toArray: async () => [] }) });
      mockFakeDb.col("friends").find
        .mockReturnValueOnce({ toArray: async () => [{ friendId: "commun-1" }] })
        .mockReturnValueOnce({ toArray: async () => [{ userId: RECIPIENT_ID, friendId: "commun-1" }] });

      // Act
      const res = await request(app).get("/friends/requests");

      // Assert
      expect(res.body[0].commonFriends).toBe(1);
    });

    it("should decrypt the recipient name and contact details of sent requests", async () => {
      // Arrange
      mockFakeDb.col("friendRequests").find
        .mockReturnValueOnce({ sort: () => ({ toArray: async () => [] }) })
        .mockReturnValueOnce({
          sort: () => ({
            toArray: async () => [
              {
                _id: new ObjectId(REQUEST_ID),
                senderId: USER_ID,
                recipientId: RECIPIENT_ID,
                recipientEmail: encrypt("bob@test.com"),
                recipientPhone: encrypt("+33612345678"),
                status: "pending",
              },
            ],
          }),
        });
      mockFind(mockFakeDb.col("friends"), []);
      mockFakeDb.col("users").find.mockReturnValue({
        project: () => ({ toArray: async () => [{ _id: new ObjectId(RECIPIENT_ID), name: encrypt("Bob") }] }),
      });

      // Act
      const res = await request(app).get("/friends/requests");

      // Assert
      expect(res.body[0]).toMatchObject({
        recipientName: "Bob",
        recipientEmail: "bob@test.com",
        recipientPhone: "+33612345678",
      });
    });

    it("should ignore sent requests carrying a malformed recipient id", async () => {
      // Arrange
      mockFakeDb.col("friendRequests").find
        .mockReturnValueOnce({ sort: () => ({ toArray: async () => [] }) })
        .mockReturnValueOnce({
          sort: () => ({
            toArray: async () => [{ _id: new ObjectId(REQUEST_ID), senderId: USER_ID, recipientId: "pas-un-id", status: "pending" }],
          }),
        });
      mockFind(mockFakeDb.col("friends"), []);
      mockFakeDb.col("users").find.mockReturnValue({ project: () => ({ toArray: async () => [] }) });

      // Act
      const res = await request(app).get("/friends/requests");

      // Assert
      expect(res.body[0].recipientName).toBeNull();
    });

    it("should return 500 when the database fails", async () => {
      // Arrange
      mockFakeDb.col("friendRequests").find.mockImplementation(() => {
        throw new Error("mongo down");
      });

      // Act
      const res = await request(app).get("/friends/requests");

      // Assert
      expect(res.status).toBe(500);
    });
  });

  describe("PUT /friends/requests/:requestId", () => {
    it("should return 400 when the action is neither accept nor decline", async () => {
      // Act
      const res = await request(app)
        .put(`/friends/requests/${REQUEST_ID}`)
        .send({ action: "ignore" });

      // Assert
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "Action invalide" });
    });

    it("should return 404 when the request does not exist", async () => {
      // Arrange
      mockFakeDb.col("friendRequests").findOne.mockResolvedValue(null);

      // Act
      const res = await request(app)
        .put(`/friends/requests/${REQUEST_ID}`)
        .send({ action: "accept" });

      // Assert
      expect(res.status).toBe(404);
    });

    it("should return 400 when the request was already processed", async () => {
      // Arrange
      mockFakeDb.col("friendRequests").findOne.mockResolvedValue({ status: "accepted" });

      // Act
      const res = await request(app)
        .put(`/friends/requests/${REQUEST_ID}`)
        .send({ action: "accept" });

      // Assert
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Demande déjà traitée");
    });

    it("should return 403 when the caller is not the recipient", async () => {
      // Arrange
      mockFakeDb.col("friendRequests").findOne.mockResolvedValue({
        status: "pending",
        recipientId: RECIPIENT_ID,
      });

      // Act
      const res = await request(app)
        .put(`/friends/requests/${REQUEST_ID}`)
        .send({ action: "accept" });

      // Assert
      expect(res.status).toBe(403);
    });

    it("should delete the request when it is declined", async () => {
      // Arrange
      mockFakeDb.col("friendRequests").findOne.mockResolvedValue({
        status: "pending",
        recipientId: USER_ID,
      });

      // Act
      const res = await request(app)
        .put(`/friends/requests/${REQUEST_ID}`)
        .send({ action: "decline" });

      // Assert
      expect(res.body).toEqual({ success: true });
      expect(mockFakeDb.col("friendRequests").deleteOne).toHaveBeenCalled();
      expect(mockFakeDb.col("friends").insertMany).not.toHaveBeenCalled();
    });

    it("should create the two friendship documents when it is accepted", async () => {
      // Arrange
      mockFakeDb.col("friendRequests").findOne.mockResolvedValue({
        status: "pending",
        recipientId: USER_ID,
        senderId: RECIPIENT_ID,
        senderName: "Bob",
      });
      mockFakeDb.col("users").findOne.mockResolvedValue(
        buildUserDoc(RECIPIENT_ID, "Bob", "bob@test.com")
      );

      // Act
      const res = await request(app)
        .put(`/friends/requests/${REQUEST_ID}`)
        .send({ action: "accept" });

      // Assert
      expect(res.body).toEqual({ success: true });
      const [docs] = mockFakeDb.col("friends").insertMany.mock.calls[0];
      expect(docs).toHaveLength(2);
      expect(docs[0].name).not.toBe("Alice");
    });

    it("should return 500 when the database fails", async () => {
      // Arrange
      mockFakeDb.col("friendRequests").findOne.mockRejectedValue(new Error("mongo down"));

      // Act
      const res = await request(app)
        .put(`/friends/requests/${REQUEST_ID}`)
        .send({ action: "accept" });

      // Assert
      expect(res.status).toBe(500);
    });
  });

  describe("DELETE /friends/requests/:requestId", () => {
    it("should return 404 when the pending request of the sender is not found", async () => {
      // Arrange
      mockFakeDb.col("friendRequests").findOne.mockResolvedValue(null);

      // Act
      const res = await request(app).delete(`/friends/requests/${REQUEST_ID}`);

      // Assert
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Demande introuvable ou déjà traitée");
    });

    it("should delete the pending request of the sender", async () => {
      // Arrange
      mockFakeDb.col("friendRequests").findOne.mockResolvedValue({ _id: REQUEST_ID });

      // Act
      const res = await request(app).delete(`/friends/requests/${REQUEST_ID}`);

      // Assert
      expect(res.body).toEqual({ success: true });
      expect(mockFakeDb.col("friendRequests").deleteOne).toHaveBeenCalledWith({
        _id: new ObjectId(REQUEST_ID),
      });
    });

    it("should return 500 when the database fails", async () => {
      // Arrange
      mockFakeDb.col("friendRequests").findOne.mockRejectedValue(new Error("mongo down"));

      // Act
      const res = await request(app).delete(`/friends/requests/${REQUEST_ID}`);

      // Assert
      expect(res.status).toBe(500);
    });
  });
});
