const express = require("express");
const { getDb } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { iapLimiter } = require("../middleware/rateLimiter");
const logger = require("../utils/logger");
const { FREE_FEATURES } = require("../utils/subscriptionHelper");
const { PLAN_DURATIONS_MS, validateAndPersist } = require("../services/iapService");
const {
  isStripeEnabled,
  createCheckoutSession,
  createBillingPortalSession,
  constructWebhookEvent,
  handleWebhookEvent,
  cancelAtPeriodEnd,
} = require("../services/stripeService");

const router = express.Router();

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
router.post("/validate-receipt", requireAuth, iapLimiter, async (req, res) => {
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
router.post("/validate", requireAuth, iapLimiter, async (req, res) => {
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

// POST /subscriptions/checkout-session — parcours d'achat web (Stripe Checkout)
router.post("/checkout-session", requireAuth, iapLimiter, async (req, res) => {
  if (!isStripeEnabled()) {
    return res.status(503).json({ success: false, error: "Paiement web indisponible" });
  }

  try {
    const { productId } = req.body;
    if (!PLAN_DURATIONS_MS[productId]) {
      return res.status(400).json({ success: false, error: "ProductId inconnu" });
    }

    const url = await createCheckoutSession({
      userId: String(req.user._id),
      email: req.user.email || null,
      productId,
    });

    return res.json({ url });
  } catch (e) {
    logger.error("[subscriptions] POST /checkout-session", e.message);
    return res.status(500).json({ success: false, error: "Création de la session impossible" });
  }
});

// POST /subscriptions/billing-portal — portail de gestion Stripe (web)
router.post("/billing-portal", requireAuth, iapLimiter, async (req, res) => {
  if (!isStripeEnabled()) {
    return res.status(503).json({ success: false, error: "Paiement web indisponible" });
  }

  try {
    const sub = await getDb()
      .collection("subscriptions")
      .findOne({ userId: String(req.user._id) });

    // Un abonnement souscrit sur mobile n'a pas de client Stripe : il se gère
    // depuis l'App Store ou le Play Store, pas depuis le portail.
    if (!sub?.stripeCustomerId) {
      return res.status(404).json({ success: false, error: "Aucun abonnement Stripe à gérer" });
    }

    const url = await createBillingPortalSession(sub.stripeCustomerId);
    return res.json({ url });
  } catch (e) {
    logger.error("[subscriptions] POST /billing-portal", e.message);
    return res.status(500).json({ success: false, error: "Ouverture du portail impossible" });
  }
});

// POST /subscriptions/webhook — notifications Stripe (corps brut, signé)
// Monté sans requireAuth : l'authenticité vient de la signature, pas d'une session.
router.post("/webhook", async (req, res) => {
  const signature = req.headers["stripe-signature"];
  if (!signature) return res.status(400).json({ success: false, error: "Signature manquante" });

  let event;
  try {
    event = constructWebhookEvent(req.body, signature);
  } catch (e) {
    logger.warn("[subscriptions] Webhook Stripe rejeté :", e.message);
    return res.status(400).json({ success: false, error: "Signature invalide" });
  }

  try {
    await handleWebhookEvent(event);
    return res.json({ received: true });
  } catch (e) {
    // 500 volontaire : Stripe réessaiera l'événement.
    logger.error(`[subscriptions] Traitement du webhook ${event.type} échoué :`, e.message);
    return res.status(500).json({ success: false, error: "Traitement impossible" });
  }
});

// POST /subscriptions/cancel — annuler un abonnement actif
router.post("/cancel", requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const userId = String(req.user._id);
    const now = new Date();

    const sub = await db.collection("subscriptions").findOne({ userId });

    if (sub?.status !== "active") {
      return res.status(400).json({ success: false, error: "Aucun abonnement actif à annuler" });
    }

    // Côté Stripe, l'annulation doit être programmée chez le PSP : sinon le
    // prélèvement suivant partirait malgré le statut local.
    if (sub.stripeSubscriptionId) {
      await cancelAtPeriodEnd(sub.stripeSubscriptionId);
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
