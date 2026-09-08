const request = require("supertest");
const express = require("express");
const webpush = require("web-push");

const USER_ID = "507f1f77bcf86cd799439011";
const VALID_SUBSCRIPTION = {
  endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
  keys: { p256dh: "cle-publique-navigateur", auth: "secret-auth" },
};

const mockUpdateOne = jest.fn();
const mockDeleteOne = jest.fn();

// Le routeur lit la configuration VAPID au chargement : on recharge le module
// pour couvrir le cas « push activé » et le dégradé « push non configuré ».
function buildApp({ vapidEnabled }) {
  jest.resetModules();

  if (vapidEnabled) {
    const keys = webpush.generateVAPIDKeys();
    process.env.VAPID_PUBLIC_KEY = keys.publicKey;
    process.env.VAPID_PRIVATE_KEY = keys.privateKey;
  } else {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
  }

  jest.doMock("../../db", () => ({
    getDb: () => ({ collection: () => ({ updateOne: mockUpdateOne, deleteOne: mockDeleteOne }) }),
  }));
  jest.doMock("../../middleware/auth", () => ({
    requireAuth: (req, _res, next) => {
      req.user = { _id: USER_ID };
      next();
    },
  }));

  const app = express();
  app.use(express.json());
  app.use("/users", require("../push"));
  return app;
}

describe("Routes Web Push", () => {
  let app;

  beforeAll(() => {
    app = buildApp({ vapidEnabled: true });
  });

  beforeEach(() => {
    mockUpdateOne.mockReset().mockResolvedValue({ upsertedCount: 1 });
    mockDeleteOne.mockReset().mockResolvedValue({ deletedCount: 1 });
  });

  it("should expose the VAPID public key when web push is configured", async () => {
    // Act
    const res = await request(app).get("/users/push/vapid-public-key");

    // Assert
    expect(res.status).toBe(200);
    expect(res.body.publicKey).toBe(process.env.VAPID_PUBLIC_KEY);
  });

  it("should return 204 and persist the subscription when the payload is valid", async () => {
    // Act
    const res = await request(app)
      .post("/users/push/subscribe")
      .send({ subscription: VALID_SUBSCRIPTION });

    // Assert
    expect(res.status).toBe(204);
    expect(mockUpdateOne).toHaveBeenCalledWith(
      { endpoint: VALID_SUBSCRIPTION.endpoint },
      expect.objectContaining({ $set: expect.objectContaining({ userId: USER_ID }) }),
      { upsert: true }
    );
  });

  it("should return 400 when the subscription payload is missing its keys", async () => {
    // Act
    const res = await request(app)
      .post("/users/push/subscribe")
      .send({ subscription: { endpoint: VALID_SUBSCRIPTION.endpoint } });

    // Assert
    expect(res.status).toBe(400);
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it("should return 400 when the subscription endpoint is not https", async () => {
    // Act
    const res = await request(app)
      .post("/users/push/subscribe")
      .send({ subscription: { ...VALID_SUBSCRIPTION, endpoint: "http://fcm.test/abc" } });

    // Assert
    expect(res.status).toBe(400);
  });

  it("should return 204 and delete only the caller subscription when unsubscribing", async () => {
    // Act
    const res = await request(app)
      .delete("/users/push/subscribe")
      .send({ endpoint: VALID_SUBSCRIPTION.endpoint });

    // Assert
    expect(res.status).toBe(204);
    expect(mockDeleteOne).toHaveBeenCalledWith({
      userId: USER_ID,
      endpoint: VALID_SUBSCRIPTION.endpoint,
    });
  });

  it("should return 400 when unsubscribing without an endpoint", async () => {
    // Act
    const res = await request(app).delete("/users/push/subscribe").send({});

    // Assert
    expect(res.status).toBe(400);
    expect(mockDeleteOne).not.toHaveBeenCalled();
  });
});

describe("Routes Web Push — VAPID non configuré", () => {
  it("should return 503 on the public key route when VAPID keys are missing", async () => {
    // Arrange
    const app = buildApp({ vapidEnabled: false });

    // Act
    const res = await request(app).get("/users/push/vapid-public-key");

    // Assert
    expect(res.status).toBe(503);
  });

  it("should return 503 without storing anything when subscribing while push is disabled", async () => {
    // Arrange
    const app = buildApp({ vapidEnabled: false });
    mockUpdateOne.mockReset();

    // Act
    const res = await request(app)
      .post("/users/push/subscribe")
      .send({ subscription: VALID_SUBSCRIPTION });

    // Assert
    expect(res.status).toBe(503);
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });
});
