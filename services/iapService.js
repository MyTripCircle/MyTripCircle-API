const https = require("node:https");
const { getDb } = require("../db");
const logger = require("../utils/logger");
const { upsertPremiumSubscription } = require("../utils/subscriptionHelper");

// Durée de chaque plan en millisecondes
const PLAN_DURATIONS_MS = {
  "com.myapp.monthly": 30 * 24 * 60 * 60 * 1000,
  "com.myapp.yearly":  365 * 24 * 60 * 60 * 1000,
};

// 21007 = reçu sandbox envoyé en prod → retenter en sandbox
function callAppleEndpoint(hostname, body) {
  return new Promise((resolve, reject) => {
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
          if (parsed.status === 21007 && hostname === "buy.itunes.apple.com") {
            return callAppleEndpoint("sandbox.itunes.apple.com", body).then(resolve).catch(reject);
          }
          resolve(parsed);
        } catch (e) {
          reject(new Error(`Réponse Apple non-JSON : ${e instanceof Error ? e.message : String(e)}`));
        }
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/**
 * Appelle l'API de vérification Apple (StoreKit 1).
 * Essaie d'abord l'endpoint production, retente en sandbox si status 21007.
 */
function verifyAppleReceipt(receiptData, sharedSecret) {
  const body = JSON.stringify({
    "receipt-data": receiptData,
    password: sharedSecret,
    "exclude-old-transactions": true,
  });
  return callAppleEndpoint("buy.itunes.apple.com", body);
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

function computeSkipValidationEndDate(productId, transactionId, userId, now) {
  const durationMs = PLAN_DURATIONS_MS[productId];
  if (durationMs) {
    logger.warn(`[subscriptions] IAP_SKIP_VALIDATION actif — validation Apple ignorée pour userId=${userId}`);
    return { endDate: new Date(now.getTime() + durationMs), resolvedTransactionId: transactionId };
  }
  throw new Error(`ProductId inconnu : ${productId}`);
}

/**
 * Calcule la date de fin pour un achat iOS en validant le reçu Apple.
 * Retourne { endDate, resolvedTransactionId }.
 */
async function computeIosEndDate({ receiptData, productId, transactionId, userId, now }) {
  if (process.env.IAP_SKIP_VALIDATION === "true") {
    return computeSkipValidationEndDate(productId, transactionId, userId, now);
  }

  const sharedSecret = process.env.APPLE_SHARED_SECRET;
  if (!sharedSecret) throw new Error("APPLE_SHARED_SECRET non configuré");

  const appleResponse = await verifyAppleReceipt(receiptData, sharedSecret);

  // status 0 = valide, 21007 = sandbox (déjà retenté dans verifyAppleReceipt)
  if (appleResponse.status !== 0) {
    logger.warn(`[subscriptions] Apple status ${appleResponse.status} pour userId=${userId}`);
    throw new Error(`Reçu Apple invalide (status ${appleResponse.status})`);
  }

  const tx = extractLatestAppleTransaction(appleResponse, productId);
  if (!tx) throw new Error("Transaction introuvable dans le reçu Apple");

  const expiresMs = Number(tx.expires_date_ms);
  if (!expiresMs || expiresMs <= Date.now()) throw new Error("Abonnement expiré ou invalide");

  return { endDate: new Date(expiresMs), resolvedTransactionId: tx.transaction_id || transactionId };
}

function computeAndroidEndDate({ productId, userId, now }) {
  if (process.env.IAP_SKIP_VALIDATION !== "true") {
    throw new Error("Validation Google Play non implémentée — achats Android refusés en production");
  }
  // Android dev uniquement (IAP_SKIP_VALIDATION=true) : bypass sans vérification Google Play
  logger.warn(`[subscriptions] IAP_SKIP_VALIDATION actif — validation Google Play ignorée pour userId=${userId}`);
  const durationMs = PLAN_DURATIONS_MS[productId];
  if (!durationMs) throw new Error(`ProductId inconnu : ${productId}`);
  return new Date(now.getTime() + durationMs);
}

/**
 * Valide et persiste un achat IAP.
 * En dev (IAP_SKIP_VALIDATION=true), l'appel Apple est bypassé.
 */
async function validateAndPersist({ userId, receiptData, platform, productId, transactionId }) {
  const db = getDb();
  const now = new Date();

  let endDate;
  let resolvedTransactionId = transactionId;

  if (platform === "ios") {
    const result = await computeIosEndDate({ receiptData, productId, transactionId, userId, now });
    endDate = result.endDate;
    resolvedTransactionId = result.resolvedTransactionId;
  } else {
    endDate = computeAndroidEndDate({ productId, userId, now });
  }

  return upsertPremiumSubscription(db, {
    userId,
    platform,
    productId,
    endDate,
    startDate: now,
    extra: { transactionId: resolvedTransactionId || null },
  });
}

module.exports = { PLAN_DURATIONS_MS, validateAndPersist };
