const express = require("express");
const https = require("node:https");
const { getDb } = require("../db");
const { requireAuth } = require("../middleware/auth");
const logger = require("../utils/logger");

const router = express.Router();

// Durée de chaque plan en millisecondes
const PLAN_DURATIONS_MS = {
  "com.myapp.monthly": 30 * 24 * 60 * 60 * 1000,
  "com.myapp.yearly":  365 * 24 * 60 * 60 * 1000,
};

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Appelle l'API de vérification Apple (StoreKit 1).
 * Essaie d'abord l'endpoint production, retente en sandbox si status 21007.
 */
function verifyAppleReceipt(receiptData, sharedSecret) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      "receipt-data": receiptData,
      password: sharedSecret,
      "exclude-old-transactions": true,
    });

    function callEndpoint(hostname) {
      const options = {
        hostname,
        path: "/verifyReceipt",
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      };

      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            // 21007 = reçu sandbox envoyé en prod → retenter en sandbox
            if (parsed.status === 21007 && hostname === "buy.itunes.apple.com") {
              return callEndpoint("sandbox.itunes.apple.com").then(resolve).catch(reject);
            }
            resolve(parsed);
          } catch (e) {
            reject(new Error("Réponse Apple non-JSON"));
          }
        });
      });

      req.on("error", reject);
      req.write(body);
      req.end();
    }

    callEndpoint("buy.itunes.apple.com");
  });
}

/**
 * Extrait la dernière transaction valide pour un productId depuis la réponse Apple.
 */
function extractLatestAppleTransaction(appleResponse, productId) {
  const inApp = appleResponse?.latest_receipt_info || appleResponse?.receipt?.in_app || [];
  const matching = inApp
    .filter((t) => t.product_id === productId)
    .sort((a, b) => Number(b.purchase_date_ms) - Number(a.purchase_date_ms));
  return matching[0] || null;
}

/**
 * Valide et persiste un achat IAP.
 * En dev (IAP_SKIP_VALIDATION=true), l'appel Apple est bypassé.
 */
async function validateAndPersist({ userId, receiptData, platform, productId, transactionId }) {
  const db = getDb();
  const skipValidation = process.env.IAP_SKIP_VALIDATION === "true";
  const now = new Date();

  let endDate;

  if (platform === "ios") {
    if (!skipValidation) {
      const sharedSecret = process.env.APPLE_SHARED_SECRET;
      if (!sharedSecret) throw new Error("APPLE_SHARED_SECRET non configuré");

      const appleResponse = await verifyAppleReceipt(receiptData, sharedSecret);

      // status 0 = valide, 21007 = sandbox (déjà retranté dans verifyAppleReceipt)
      if (appleResponse.status !== 0) {
        logger.warn(`[subscriptions] Apple status ${appleResponse.status} pour userId=${userId}`);
        throw new Error(`Reçu Apple invalide (status ${appleResponse.status})`);
      }

      const tx = extractLatestAppleTransaction(appleResponse, productId);
      if (!tx) throw new Error("Transaction introuvable dans le reçu Apple");

      const expiresMs = Number(tx.expires_date_ms);
      if (!expiresMs || expiresMs <= Date.now()) throw new Error("Abonnement expiré ou invalide");

      endDate = new Date(expiresMs);
      transactionId = tx.transaction_id || transactionId;
    } else {
      // Mode dev : durée calculée côté serveur
      const durationMs = PLAN_DURATIONS_MS[productId];
      if (!durationMs) throw new Error(`ProductId inconnu : ${productId}`);
      endDate = new Date(now.getTime() + durationMs);
      logger.warn(`[subscriptions] IAP_SKIP_VALIDATION actif — validation Apple ignorée pour userId=${userId}`);
    }
  } else {
    // Android : à implémenter via Google Play Developer API
    const durationMs = PLAN_DURATIONS_MS[productId];
    if (!durationMs) throw new Error(`ProductId inconnu : ${productId}`);
    endDate = new Date(now.getTime() + durationMs);
  }

  const subscription = {
    userId,
    plan: "premium",
    status: "active",
    platform,
    productId,
    transactionId: transactionId || null,
    features: PREMIUM_FEATURES,
    startDate: now,
    endDate,
    nextBillingDate: endDate,
    cancelledAt: null,
    updatedAt: now,
  };

  await db.collection("subscriptions").updateOne(
    { userId },
    { $set: subscription, $setOnInsert: { createdAt: now } },
    { upsert: true }
  );

  return { ...subscription };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// GET /subscriptions/me — abonnement actuel (plan gratuit par défaut)
router.get("/me", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const userId = String(req.user._id);
    const now = new Date();

    const sub = await db.collection("subscriptions").findOne({ userId });

    if (!sub) {
      return res.json({
        plan: "free",
        status: "active",
        features: FREE_FEATURES,
        startDate: now,
        endDate: null,
        cancelledAt: null,
        nextBillingDate: null,
      });
    }

    // Expirer automatiquement si la date est dépassée
    if (sub.status === "active" && sub.endDate && new Date(sub.endDate) < now) {
      await db.collection("subscriptions").updateOne(
        { userId },
        { $set: { status: "expired", updatedAt: now } }
      );
      sub.status = "expired";
    }

    return res.json(sub);
  } catch (e) {
    logger.error("[subscriptions] GET /me", e.message);
    return res.status(500).json({ success: false, error: "Erreur interne du serveur" });
  }
});

// POST /subscriptions/validate-receipt — appelé par useSubscriptionIap après achat
router.post("/validate-receipt", requireAuth, async (req, res) => {
  try {
    const userId = String(req.user._id);
    const { receipt, platform, productId } = req.body;

    if (!receipt || typeof receipt !== "string") {
      return res.status(400).json({ success: false, error: "Reçu manquant ou invalide" });
    }
    if (!["ios", "android"].includes(platform)) {
      return res.status(400).json({ success: false, error: "Plateforme invalide" });
    }
    if (!PLAN_DURATIONS_MS[productId]) {
      return res.status(400).json({ success: false, error: "ProductId inconnu" });
    }

    await validateAndPersist({ userId, receiptData: receipt, platform, productId });

    return res.json({ success: true });
  } catch (e) {
    logger.error("[subscriptions] POST /validate-receipt", e.message);
    return res.status(400).json({ success: false, error: e.message });
  }
});

// POST /subscriptions/validate — appelé par SubscriptionContext.purchaseSubscription()
router.post("/validate", requireAuth, async (req, res) => {
  try {
    const userId = String(req.user._id);
    const { receiptData, platform, productId, transactionId } = req.body;

    if (!receiptData || typeof receiptData !== "string") {
      return res.status(400).json({ success: false, error: "Reçu manquant ou invalide" });
    }
    if (!["ios", "android"].includes(platform)) {
      return res.status(400).json({ success: false, error: "Plateforme invalide" });
    }
    if (!PLAN_DURATIONS_MS[productId]) {
      return res.status(400).json({ success: false, error: "ProductId inconnu" });
    }

    await validateAndPersist({ userId, receiptData, platform, productId, transactionId });

    return res.json({ success: true });
  } catch (e) {
    logger.error("[subscriptions] POST /validate", e.message);
    return res.status(400).json({ success: false, error: e.message });
  }
});

// POST /subscriptions/cancel — annuler un abonnement actif
router.post("/cancel", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const userId = String(req.user._id);
    const now = new Date();

    const sub = await db.collection("subscriptions").findOne({ userId });

    if (!sub || sub.status !== "active") {
      return res.status(400).json({ success: false, error: "Aucun abonnement actif à annuler" });
    }

    // Annulation Apple = accès jusqu'à endDate (billing period déjà payé)
    await db.collection("subscriptions").updateOne(
      { userId },
      { $set: { status: "cancelled", cancelledAt: now, updatedAt: now } }
    );

    return res.json({ success: true, message: "Abonnement annulé — accès maintenu jusqu'à la fin de la période" });
  } catch (e) {
    logger.error("[subscriptions] POST /cancel", e.message);
    return res.status(500).json({ success: false, error: "Erreur interne du serveur" });
  }
});

module.exports = router;
