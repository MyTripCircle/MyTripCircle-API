const { getDb } = require("../db");
const logger = require("./logger");

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // toutes les 24h

async function purgeDeletedAccounts() {
  try {
    const db = getDb();
    const now = new Date();

    // 1. Suppression définitive des comptes dont le délai de 7 jours est écoulé
    const pendingUsers = await db
      .collection("users")
      .find({ pendingDeletion: true, deletionScheduledAt: { $lte: now } })
      .toArray();

    for (const user of pendingUsers) {
      const userIdStr = String(user._id);
      try {
        await Promise.all([
          db.collection("trips").deleteMany({ ownerId: userIdStr }),
          db.collection("bookings").deleteMany({ userId: userIdStr }),
          db.collection("addresses").deleteMany({ userId: userIdStr }),
          db.collection("invitations").deleteMany({
            $or: [{ inviterId: userIdStr }, { inviteeId: userIdStr }],
          }),
          db.collection("friends").deleteMany({
            $or: [{ userId: userIdStr }, { friendId: userIdStr }],
          }),
          db.collection("friendRequests").deleteMany({
            $or: [{ senderId: userIdStr }, { recipientId: userIdStr }],
          }),
          db.collection("refreshTokens").deleteMany({ userId: userIdStr }),
          db.collection("itinerary_usage").deleteMany({ userId: userIdStr }),
        ]);
        await db.collection("users").deleteOne({ _id: user._id });
        logger.info(`[cleanup] Compte ${userIdStr} supprimé définitivement (délai 7j écoulé)`);
      } catch (err) {
        logger.error(`[cleanup] Erreur suppression compte ${userIdStr}:`, err.message);
      }
    }

    if (pendingUsers.length > 0) {
      logger.info(`[cleanup] ${pendingUsers.length} compte(s) supprimé(s) définitivement`);
    }

    // 2. Nettoyage des refresh tokens expirés
    const expiredTokensResult = await db
      .collection("refreshTokens")
      .deleteMany({ expiresAt: { $lte: now } });
    if (expiredTokensResult.deletedCount > 0) {
      logger.info(`[cleanup] ${expiredTokensResult.deletedCount} refresh token(s) expirés supprimés`);
    }
  } catch (err) {
    logger.error("[cleanup] Erreur lors du nettoyage:", err.message);
  }
}

function startCleanupJob() {
  // Exécution immédiate au démarrage, puis toutes les 24h
  purgeDeletedAccounts();
  setInterval(purgeDeletedAccounts, CLEANUP_INTERVAL_MS);
  logger.info("[cleanup] Job de nettoyage démarré (intervalle: 24h)");
}

module.exports = { startCleanupJob };
