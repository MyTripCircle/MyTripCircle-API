/**
 * Quotas applicables à un compte sans abonnement actif.
 *
 * Sert aussi de repli en cas d'abonnement introuvable ou expiré. Le choix de
 * dégrader vers l'offre gratuite plutôt que de rejeter la requête est
 * délibéré : une défaillance de la couche d'abonnement ne doit pas priver
 * l'utilisateur de ses données, seulement des fonctions payantes. L'inverse —
 * accorder l'offre complète par défaut — ferait d'un incident une distribution
 * gratuite du service.
 *
 * @type {{ maxTrips: number, maxCollaborators: number, canExport: boolean,
 *   prioritySupport: boolean, maxAttachments: number }}
 */
const FREE_FEATURES = {
  maxTrips: 3,
  maxCollaborators: 2,
  canExport: false,
  prioritySupport: false,
  maxAttachments: 2,
};

const PREMIUM_FEATURES = {
  maxTrips: -1,
  maxCollaborators: -1,
  canExport: true,
  prioritySupport: true,
  maxAttachments: -1,
};

/**
 * Persiste un abonnement premium actif. Partagé par l'IAP mobile et Stripe web
 * pour que la forme du document en base ne dépende pas du canal d'achat.
 */
async function upsertPremiumSubscription(db, { userId, platform, productId, endDate, startDate, extra = {} }) {
  // L'appelant dérive `endDate` de son propre instant de référence. Reprendre
  // cet instant plutôt qu'en produire un second garantit que la durée persistée
  // est exactement celle du plan : deux `new Date()` séparés d'une milliseconde
  // suffisent à la fausser.
  const now = startDate ? new Date(startDate) : new Date();
  const subscription = {
    userId: String(userId),
    plan: "premium",
    status: "active",
    platform,
    productId,
    features: PREMIUM_FEATURES,
    startDate: now,
    endDate,
    nextBillingDate: endDate,
    cancelledAt: null,
    updatedAt: now,
    ...extra,
  };

  await db.collection("subscriptions").updateOne(
    { userId: String(userId) },
    { $set: subscription, $setOnInsert: { createdAt: now } },
    { upsert: true }
  );

  return subscription;
}

/**
 * Détermine les quotas en vigueur pour un utilisateur.
 *
 * Un abonnement résilié conserve ses droits jusqu'à l'échéance déjà payée :
 * l'utilisateur a réglé la période, la résiliation ne fait que supprimer la
 * reconduction. Couper l'accès au moment de la résiliation reviendrait à
 * facturer un service retiré.
 *
 * L'échéance est comparée à l'instant courant à chaque appel plutôt que
 * matérialisée par une tâche qui basculerait le statut : aucune fenêtre ne
 * subsiste alors entre l'expiration réelle et sa prise en compte.
 *
 * Une copie des quotas gratuits est rendue et non la constante elle-même, pour
 * qu'un appelant qui modifierait l'objet reçu n'altère pas la référence
 * partagée par tous les comptes.
 *
 * @param {import("mongodb").Db} db Base de données ; passée en paramètre pour
 *   que la fonction reste testable sans connexion établie.
 * @param {string} userId Identifiant de l'utilisateur.
 * @returns {Promise<object>} Quotas applicables. Une valeur `-1` désigne une
 *   absence de limite.
 * @throws {Error} Si la lecture en base échoue.
 */
async function getUserFeatures(db, userId) {
  const sub = await db.collection("subscriptions").findOne({ userId });
  if (!sub) return { ...FREE_FEATURES };

  const isActive =
    sub.status === "active" ||
    (sub.status === "cancelled" &&
      sub.endDate &&
      new Date(sub.endDate) > new Date());

  return isActive ? sub.features : { ...FREE_FEATURES };
}

module.exports = { FREE_FEATURES, PREMIUM_FEATURES, getUserFeatures, upsertPremiumSubscription };
