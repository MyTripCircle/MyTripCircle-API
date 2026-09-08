const { getDb } = require("../db");
const logger = require("./logger");

/**
 * Purge périodique de ce qu'un index TTL ne sait pas exprimer.
 *
 * Les durées de conservation du projet sont portées par des index TTL déclarés
 * dans `db.js`, qui s'appliquent indépendamment de l'exécution du serveur. Cette
 * tâche ne les double pas : elle couvre les deux cas hors de portée d'un TTL,
 * à savoir la suppression en cascade d'un compte à travers une dizaine de
 * collections, et le retrait de l'utilisateur des voyages appartenant à
 * d'autres. Un index TTL agit sur un document isolé et ne peut ni propager ni
 * modifier autrui.
 *
 * @module utils/cleanupJob
 */

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // toutes les 24h

/**
 * Supprime définitivement les comptes dont le délai de rétractation est écoulé
 * et retire les jetons de rafraîchissement expirés.
 *
 * La suppression est différée de sept jours après la demande — délai matérialisé
 * par `deletionScheduledAt`, posé au moment de la demande et non ici — afin que
 * l'utilisateur puisse revenir sur une décision irréversible. Ce n'est qu'une
 * fois l'échéance atteinte que l'effacement devient effectif, au titre de
 * l'article 17 du RGPD.
 *
 * Les voyages dont l'utilisateur n'est que collaborateur sont conservés et
 * seule sa participation en est retirée : ils appartiennent à d'autres
 * personnes, dont le droit à l'effacement d'un tiers ne saurait supprimer les
 * données.
 *
 * Chaque compte est traité dans son propre bloc de rattrapage. Un document
 * corrompu ou une collection indisponible ne doit pas interrompre le passage et
 * laisser les comptes suivants indéfiniment en attente ; l'échec est journalisé
 * et le compte sera retenté au passage suivant, la condition de sélection
 * restant vraie.
 *
 * @returns {Promise<void>} Résolue à la fin du passage. N'émet jamais d'erreur :
 *   les échecs sont journalisés, un incident de purge ne devant pas propager
 *   un rejet non intercepté dans un `setInterval`.
 */
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
          // Données appartenant à l'utilisateur
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
          // RGPD — preuves de consentement supprimées avec le compte
          db.collection("user_consents").deleteMany({ userId: userIdStr }),
          // Liens d'invitation amis créés par l'utilisateur
          db.collection("friendInviteLinks").deleteMany({ userId: userIdStr }),
        ]);

        // RGPD Art. 17 — Retirer l'utilisateur des voyages dont il est collaborateur
        // (les voyages eux-mêmes restent car ils appartiennent aux autres propriétaires)
        await db.collection("trips").updateMany(
          { "collaborators.userId": userIdStr },
          { $pull: { collaborators: { userId: userIdStr } } }
        );

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

/**
 * Arme la purge périodique et en déclenche un premier passage.
 *
 * Le passage immédiat rattrape les échéances survenues pendant une
 * interruption : sans lui, un serveur redémarré chaque jour n'atteindrait
 * jamais le premier déclenchement du minuteur et les comptes resteraient en
 * attente indéfiniment.
 *
 * À n'appeler qu'une fois par processus, après {@link module:db.connectMongo} :
 * un second appel poserait un minuteur concurrent sans annuler le précédent.
 *
 * @returns {void}
 */
function startCleanupJob() {
  // Exécution immédiate au démarrage, puis toutes les 24h
  purgeDeletedAccounts();
  setInterval(purgeDeletedAccounts, CLEANUP_INTERVAL_MS);
  logger.info("[cleanup] Job de nettoyage démarré (intervalle: 24h)");
}

module.exports = { startCleanupJob };
