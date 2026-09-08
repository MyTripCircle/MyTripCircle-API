const Stripe = require("stripe");
const { STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICES } = require("../config");
const { getDb } = require("../db");
const logger = require("../utils/logger");
const { upsertPremiumSubscription } = require("../utils/subscriptionHelper");
const { buildWebAppUrl } = require("../utils/webRedirect");

// Chemin de l'écran Abonnement côté client web. Doit rester synchronisé avec
// `src/navigation/linking.ts` (clé `Subscription`) : Stripe renvoie l'utilisateur
// sur cette URL après paiement, une divergence l'enverrait sur l'écran 404.
const SUBSCRIPTION_PATH = "/abonnement";

let stripeClient = null;

// Stripe est optionnel : sans clé, seules les routes web de paiement sont
// indisponibles (503). L'IAP mobile et le reste de l'API restent opérationnels.
function isStripeEnabled() {
  return Boolean(STRIPE_SECRET_KEY);
}

function getStripe() {
  if (!isStripeEnabled()) return null;
  stripeClient ??= new Stripe(STRIPE_SECRET_KEY);
  return stripeClient;
}

// Le client n'envoie qu'un productId applicatif : les identifiants de prix
// Stripe ne transitent jamais par le navigateur (sinon un utilisateur pourrait
// s'abonner à un prix arbitraire, y compris un prix de test à 0 €).
function priceForProduct(productId) {
  return STRIPE_PRICES[productId] || null;
}

function productForPrice(priceId) {
  return Object.keys(STRIPE_PRICES).find((key) => STRIPE_PRICES[key] === priceId) || null;
}

// Selon la version d'API Stripe, la fin de période est portée par l'abonnement
// ou par son premier item : on gère les deux pour rester stable aux migrations.
function periodEndDate(subscription) {
  const seconds =
    subscription?.current_period_end ?? subscription?.items?.data?.[0]?.current_period_end;
  return seconds ? new Date(seconds * 1000) : null;
}

/**
 * Crée une session Stripe Checkout en mode abonnement.
 * Retourne l'URL vers laquelle rediriger l'utilisateur.
 */
async function createCheckoutSession({ userId, email, productId }) {
  const stripe = getStripe();
  if (!stripe) throw new Error("Stripe non configuré");

  const price = priceForProduct(productId);
  if (!price) throw new Error(`ProductId inconnu : ${productId}`);

  const successUrl = buildWebAppUrl(SUBSCRIPTION_PATH, { checkout: "success" });
  const cancelUrl = buildWebAppUrl(SUBSCRIPTION_PATH, { checkout: "cancel" });
  if (!successUrl || !cancelUrl) throw new Error("WEB_APP_URL non configuré");

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price, quantity: 1 }],
    // Rattache le paiement au compte : c'est cette valeur que le webhook relit.
    client_reference_id: String(userId),
    ...(email ? { customer_email: email } : {}),
    success_url: successUrl,
    cancel_url: cancelUrl,
  });

  return session.url;
}

/**
 * Ouvre le portail de facturation Stripe : moyen de paiement, factures et
 * résiliation. C'est l'équivalent web des pages « Gérer l'abonnement » de
 * l'App Store et du Play Store, qui n'ont pas de sens dans un navigateur.
 */
async function createBillingPortalSession(stripeCustomerId) {
  const stripe = getStripe();
  if (!stripe) throw new Error("Stripe non configuré");

  const returnUrl = buildWebAppUrl(SUBSCRIPTION_PATH);
  if (!returnUrl) throw new Error("WEB_APP_URL non configuré");

  const session = await stripe.billingPortal.sessions.create({
    customer: stripeCustomerId,
    return_url: returnUrl,
  });

  return session.url;
}

function constructWebhookEvent(rawBody, signature) {
  const stripe = getStripe();
  if (!stripe || !STRIPE_WEBHOOK_SECRET) throw new Error("Stripe non configuré");
  return stripe.webhooks.constructEvent(rawBody, signature, STRIPE_WEBHOOK_SECRET);
}

async function onCheckoutCompleted(session) {
  const userId = session.client_reference_id;
  const subscriptionId =
    typeof session.subscription === "string" ? session.subscription : session.subscription?.id;

  if (!userId || !subscriptionId) {
    logger.warn("[stripe] checkout.session.completed sans client_reference_id ou subscription");
    return;
  }

  const subscription = await getStripe().subscriptions.retrieve(subscriptionId);
  const priceId = subscription.items?.data?.[0]?.price?.id;
  const productId = productForPrice(priceId);
  if (!productId) throw new Error(`Price Stripe non mappé : ${priceId}`);

  await upsertPremiumSubscription(getDb(), {
    userId,
    platform: "web",
    productId,
    endDate: periodEndDate(subscription),
    extra: {
      stripeSubscriptionId: subscription.id,
      stripeCustomerId: String(session.customer || subscription.customer || "") || null,
      transactionId: null,
    },
  });
}

function mapStripeStatus(subscription, eventType) {
  if (eventType === "customer.subscription.deleted") return "expired";
  // cancel_at_period_end : l'accès reste ouvert jusqu'à la fin de la période payée
  if (subscription.cancel_at_period_end) return "cancelled";
  if (subscription.status === "active" || subscription.status === "trialing") return "active";
  if (subscription.status === "canceled") return "cancelled";
  return "expired";
}

async function onSubscriptionChanged(subscription, eventType) {
  const db = getDb();
  const existing = await db
    .collection("subscriptions")
    .findOne({ stripeSubscriptionId: subscription.id });

  if (!existing) {
    logger.warn(`[stripe] ${eventType} sur un abonnement inconnu en base — ignoré`);
    return;
  }

  const status = mapStripeStatus(subscription, eventType);
  const endDate = periodEndDate(subscription) || existing.endDate || null;

  await db.collection("subscriptions").updateOne(
    { _id: existing._id },
    {
      $set: {
        status,
        endDate,
        nextBillingDate: status === "active" ? endDate : null,
        cancelledAt: status === "active" ? null : existing.cancelledAt || new Date(),
        updatedAt: new Date(),
      },
    }
  );
}

async function handleWebhookEvent(event) {
  switch (event.type) {
    case "checkout.session.completed":
      return onCheckoutCompleted(event.data.object);
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      return onSubscriptionChanged(event.data.object, event.type);
    default:
      logger.debug(`[stripe] Événement non traité : ${event.type}`);
      return null;
  }
}

/**
 * Programme la fin de l'abonnement Stripe en fin de période payée.
 * L'accès reste ouvert jusqu'à endDate, comme pour une annulation Apple.
 */
async function cancelAtPeriodEnd(stripeSubscriptionId) {
  const stripe = getStripe();
  if (!stripe) throw new Error("Stripe non configuré");
  await stripe.subscriptions.update(stripeSubscriptionId, { cancel_at_period_end: true });
}

module.exports = {
  isStripeEnabled,
  createCheckoutSession,
  createBillingPortalSession,
  constructWebhookEvent,
  handleWebhookEvent,
  cancelAtPeriodEnd,
};
