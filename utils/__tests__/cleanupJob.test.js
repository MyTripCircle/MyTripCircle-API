const { createFakeDb, mockFind } = require("../../__tests__/helpers/fakeDb");

// Préfixe `mock` obligatoire : la factory de jest.mock est hoistée au-dessus des require.
const mockFakeDb = createFakeDb();
const mockGetDb = jest.fn(() => mockFakeDb.db);

jest.mock("../../db", () => ({ getDb: mockGetDb }));
jest.mock("../logger", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const logger = require("../logger");
const { startCleanupJob } = require("../cleanupJob");

const USER_ID = "507f1f77bcf86cd799439011";
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** Laisse se dérouler la purge asynchrone lancée sans await par le job. */
const flushPendingWork = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Démarre le job (ce qui déclenche une purge immédiate) et attend sa fin.
 * `setInterval` est neutralisé pour qu'aucun timer réel ne survive au test ;
 * le callback capturé est renvoyé pour pouvoir simuler le tick suivant.
 */
async function runCleanupOnce() {
  const setIntervalSpy = jest
    .spyOn(global, "setInterval")
    .mockImplementation(() => 0);
  startCleanupJob();
  await flushPendingWork();
  const [scheduledFn, intervalMs] = setIntervalSpy.mock.calls[0];
  setIntervalSpy.mockRestore();
  return { scheduledFn, intervalMs };
}

describe("cleanupJob", () => {
  beforeEach(() => {
    mockFakeDb.reset();
    jest.clearAllMocks();
    mockGetDb.mockImplementation(() => mockFakeDb.db);
  });

  it("should query the accounts whose 7-day deletion delay has elapsed", async () => {
    // Act
    await runCleanupOnce();

    // Assert
    const [query] = mockFakeDb.col("users").find.mock.calls[0];
    expect(query.pendingDeletion).toBe(true);
    expect(query.deletionScheduledAt.$lte).toBeInstanceOf(Date);
  });

  it("should delete every collection owned by a purged account", async () => {
    // Arrange
    mockFind(mockFakeDb.col("users"), [{ _id: USER_ID }]);

    // Act
    await runCleanupOnce();

    // Assert
    expect(mockFakeDb.col("trips").deleteMany).toHaveBeenCalledWith({
      ownerId: USER_ID,
    });
    expect(mockFakeDb.col("bookings").deleteMany).toHaveBeenCalledWith({
      userId: USER_ID,
    });
    expect(mockFakeDb.col("addresses").deleteMany).toHaveBeenCalledWith({
      userId: USER_ID,
    });
    expect(mockFakeDb.col("invitations").deleteMany).toHaveBeenCalledWith({
      $or: [{ inviterId: USER_ID }, { inviteeId: USER_ID }],
    });
    expect(mockFakeDb.col("friends").deleteMany).toHaveBeenCalledWith({
      $or: [{ userId: USER_ID }, { friendId: USER_ID }],
    });
    expect(mockFakeDb.col("friendRequests").deleteMany).toHaveBeenCalledWith({
      $or: [{ senderId: USER_ID }, { recipientId: USER_ID }],
    });
    expect(mockFakeDb.col("refreshTokens").deleteMany).toHaveBeenCalledWith({
      userId: USER_ID,
    });
    expect(mockFakeDb.col("itinerary_usage").deleteMany).toHaveBeenCalledWith({
      userId: USER_ID,
    });
    expect(mockFakeDb.col("user_consents").deleteMany).toHaveBeenCalledWith({
      userId: USER_ID,
    });
    expect(
      mockFakeDb.col("friendInviteLinks").deleteMany
    ).toHaveBeenCalledWith({ userId: USER_ID });
  });

  it("should pull the purged user out of the trips they only collaborated on", async () => {
    // Arrange
    mockFind(mockFakeDb.col("users"), [{ _id: USER_ID }]);

    // Act
    await runCleanupOnce();

    // Assert — RGPD Art. 17 : le voyage d'un autre propriétaire n'est pas supprimé
    expect(mockFakeDb.col("trips").updateMany).toHaveBeenCalledWith(
      { "collaborators.userId": USER_ID },
      { $pull: { collaborators: { userId: USER_ID } } }
    );
  });

  it("should delete the user document itself once its data is purged", async () => {
    // Arrange
    mockFind(mockFakeDb.col("users"), [{ _id: USER_ID }]);

    // Act
    await runCleanupOnce();

    // Assert
    expect(mockFakeDb.col("users").deleteOne).toHaveBeenCalledWith({
      _id: USER_ID,
    });
    expect(logger.info).toHaveBeenCalledWith(
      `[cleanup] Compte ${USER_ID} supprimé définitivement (délai 7j écoulé)`
    );
    expect(logger.info).toHaveBeenCalledWith(
      "[cleanup] 1 compte(s) supprimé(s) définitivement"
    );
  });

  it("should keep purging the other accounts when one of them fails", async () => {
    // Arrange
    const secondUserId = "507f1f77bcf86cd799439012";
    mockFind(mockFakeDb.col("users"), [
      { _id: USER_ID },
      { _id: secondUserId },
    ]);
    mockFakeDb
      .col("bookings")
      .deleteMany.mockRejectedValueOnce(new Error("collection verrouillée"));

    // Act
    await runCleanupOnce();

    // Assert
    expect(logger.error).toHaveBeenCalledWith(
      `[cleanup] Erreur suppression compte ${USER_ID}:`,
      "collection verrouillée"
    );
    expect(mockFakeDb.col("users").deleteOne).toHaveBeenCalledWith({
      _id: secondUserId,
    });
  });

  it("should not report any deletion when no account is due", async () => {
    // Act — la base factice renvoie une liste vide par défaut
    await runCleanupOnce();

    // Assert
    expect(mockFakeDb.col("users").deleteOne).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.stringContaining("supprimé(s) définitivement")
    );
  });

  it("should purge the expired refresh tokens and report the count", async () => {
    // Arrange
    mockFakeDb
      .col("refreshTokens")
      .deleteMany.mockResolvedValue({ deletedCount: 3 });

    // Act
    await runCleanupOnce();

    // Assert
    const lastCall = mockFakeDb.col("refreshTokens").deleteMany.mock.calls.at(-1);
    expect(lastCall[0].expiresAt.$lte).toBeInstanceOf(Date);
    expect(logger.info).toHaveBeenCalledWith(
      "[cleanup] 3 refresh token(s) expirés supprimés"
    );
  });

  it("should stay silent when no refresh token has expired", async () => {
    // Act — la base factice renvoie deletedCount = 0 par défaut
    await runCleanupOnce();

    // Assert
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.stringContaining("refresh token(s) expirés")
    );
  });

  it("should log the failure without throwing when the database is unreachable", async () => {
    // Arrange
    mockGetDb.mockImplementation(() => {
      throw new Error("connexion Mongo perdue");
    });

    // Act
    await runCleanupOnce();

    // Assert
    expect(logger.error).toHaveBeenCalledWith(
      "[cleanup] Erreur lors du nettoyage:",
      "connexion Mongo perdue"
    );
  });

  it("should run a first purge immediately when the job starts", async () => {
    // Act
    await runCleanupOnce();

    // Assert
    expect(mockGetDb).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      "[cleanup] Job de nettoyage démarré (intervalle: 24h)"
    );
  });

  it("should schedule the next purge 24 hours later", async () => {
    // Arrange
    const { scheduledFn, intervalMs } = await runCleanupOnce();

    // Act
    scheduledFn();
    await flushPendingWork();

    // Assert
    expect(intervalMs).toBe(ONE_DAY_MS);
    expect(mockGetDb).toHaveBeenCalledTimes(2);
  });
});
