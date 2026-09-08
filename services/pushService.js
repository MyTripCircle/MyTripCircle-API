const webpush = require("web-push");
const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, WEB_APP_URL } = require("../config");
const { getDb } = require("../db");
const logger = require("../utils/logger");

const COLLECTION = "pushSubscriptions";

// Le push web est optionnel : sans clés VAPID, les routes le signalent (503)
// et l'envoi devient un no-op — plutôt qu'un crash au démarrage.
let vapidConfigured = false;

function isWebPushEnabled() {
  return Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
}

function getPublicKey() {
  return VAPID_PUBLIC_KEY || null;
}

function ensureVapidConfigured() {
  if (vapidConfigured) return;
  // Le sujet VAPID identifie l'émetteur auprès du service de push (mailto: ou URL)
  const subject = VAPID_SUBJECT || WEB_APP_URL || "mailto:contact@mytripcircle.app";
  webpush.setVapidDetails(subject, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  vapidConfigured = true;
}

// Un abonnement PushSubscription valide expose un endpoint HTTPS et les deux
// clés de chiffrement du navigateur.
function isValidSubscription(subscription) {
  if (!subscription || typeof subscription !== "object") return false;
  const { endpoint, keys } = subscription;
  if (typeof endpoint !== "string" || !endpoint.startsWith("https://")) return false;
  return typeof keys?.p256dh === "string" && typeof keys?.auth === "string";
}

async function saveSubscription(userId, subscription) {
  const db = getDb();
  const now = new Date();

  await db.collection(COLLECTION).updateOne(
    { endpoint: subscription.endpoint },
    {
      $set: {
        userId: String(userId),
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
        expirationTime: subscription.expirationTime ?? null,
        updatedAt: now,
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true }
  );
}

// Le filtre inclut userId : un utilisateur ne peut pas supprimer l'abonnement d'un autre.
async function removeSubscription(userId, endpoint) {
  await getDb().collection(COLLECTION).deleteOne({ userId: String(userId), endpoint });
}

async function purgeSubscription(endpoint) {
  await getDb().collection(COLLECTION).deleteOne({ endpoint });
  logger.info("[push] Abonnement expiré purgé");
}

async function deliver(sub, payload) {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: sub.keys },
      JSON.stringify(payload)
    );
    return true;
  } catch (e) {
    // 404/410 = abonnement révoqué côté navigateur : le conserver ferait
    // échouer tous les envois suivants indéfiniment.
    if (e.statusCode === 404 || e.statusCode === 410) {
      await purgeSubscription(sub.endpoint);
    } else {
      // L'endpoint n'est pas loggué : il identifie l'appareil de l'utilisateur.
      logger.error("[push] Envoi web push échoué :", e.message);
    }
    return false;
  }
}

/**
 * Envoie une notification à tous les navigateurs enregistrés d'un utilisateur.
 * Point d'entrée unique des notifications côté serveur : les futurs canaux
 * (Expo/APNs) doivent être branchés ici plutôt qu'en parallèle.
 */
async function sendPushToUser(userId, payload) {
  if (!isWebPushEnabled()) return { sent: 0, disabled: true };
  ensureVapidConfigured();

  const subs = await getDb().collection(COLLECTION).find({ userId: String(userId) }).toArray();

  // Séquentiel assumé : quelques appareils par utilisateur, pas de gain à paralléliser.
  let sent = 0;
  for (const sub of subs) {
    const delivered = await deliver(sub, payload);
    if (delivered) sent += 1;
  }
  return { sent, disabled: false };
}

module.exports = {
  isWebPushEnabled,
  getPublicKey,
  isValidSubscription,
  saveSubscription,
  removeSubscription,
  sendPushToUser,
};
