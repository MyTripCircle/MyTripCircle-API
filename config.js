// Validation des variables d'environnement au démarrage
// Stripe et VAPID restent volontairement hors de cette liste : leur absence
// désactive la fonctionnalité concernée (paiement web / push web) au lieu de
// bloquer le démarrage — l'app mobile n'en a pas besoin.
const REQUIRED_VARS = ["MONGODB_URI", "JWT_SECRET", "REFRESH_SECRET", "ENCRYPTION_KEY", "HMAC_KEY"];

const IS_PRODUCTION = process.env.NODE_ENV === "production";

// Allowlist CORS. `credentials: true` interdit le wildcard côté navigateur :
// la liste doit être explicite, sous peine de blocage de toutes les requêtes.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

// Mapping productId applicatif → price Stripe. Les identifiants produits sont
// partagés avec l'IAP mobile pour qu'un même abonnement soit décrit pareil
// quelle que soit la plateforme d'achat.
const STRIPE_PRICES = {
  "com.myapp.monthly": process.env.STRIPE_PRICE_MONTHLY || "",
  "com.myapp.yearly": process.env.STRIPE_PRICE_YEARLY || "",
};

function validateEnv() {
  const missing = REQUIRED_VARS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    // console.error direct : logger non disponible avant l'initialisation de l'app
    console.error(
      `[config] Variables d'environnement manquantes : ${missing.join(", ")}`
    );
    process.exit(1);
  }

  // RGPD Art. 32 — Vérification du format et de l'entropie des clés cryptographiques
  const encKey = process.env.ENCRYPTION_KEY;
  if (!/^[0-9a-fA-F]{64}$/.test(encKey)) {
    console.error("[config] ENCRYPTION_KEY doit être une chaîne hexadécimale de 64 caractères (32 octets). Générez-en une avec : node -e \"console.log(require('node:crypto').randomBytes(32).toString('hex'))\"") // NOSONAR;
    process.exit(1);
  }

  const hmacKey = process.env.HMAC_KEY;
  if (!/^[0-9a-fA-F]{64,}$/.test(hmacKey)) {
    console.error("[config] HMAC_KEY doit être une chaîne hexadécimale d'au moins 64 caractères (32 octets). Générez-en une avec : node -e \"console.log(require('node:crypto').randomBytes(32).toString('hex'))\"") // NOSONAR;
    process.exit(1);
  }

  if (process.env.JWT_SECRET === "dev-secret-change-me") {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "[config] JWT_SECRET utilise la valeur par défaut. Changez-la avant de démarrer en production."
      );
    }
    console.warn(
      "[config] AVERTISSEMENT : JWT_SECRET est encore la valeur par défaut. Changez-la avant de passer en production."
    );
  }

  // Sans allowlist, l'authentification par cookie est inutilisable depuis un
  // navigateur (CORS avec credentials refuse le wildcard) : on échoue vite
  // plutôt que de livrer une API silencieusement inaccessible au front web.
  if (IS_PRODUCTION && ALLOWED_ORIGINS.length === 0) {
    console.error(
      "[config] ALLOWED_ORIGINS est vide. Renseignez la liste des origines web autorisées (séparées par des virgules)."
    );
    process.exit(1);
  }

  if (process.env.NODE_ENV === "production") {
    const SECRETS_PROVIDER = process.env.SECRETS_PROVIDER || "env";
    if (SECRETS_PROVIDER === "env") {
      console.warn(
        "[config] AVERTISSEMENT RGPD : Les secrets sont chargés depuis les variables d'environnement. " +
        "En production, préférez un gestionnaire de secrets (AWS Secrets Manager, HashiCorp Vault, etc.) " +
        "via la variable SECRETS_PROVIDER."
      );
    }
  }
}

module.exports = {
  validateEnv,
  IS_PRODUCTION,
  ALLOWED_ORIGINS,
  PORT: process.env.API_PORT ? Number.parseInt(process.env.API_PORT, 10) : 4000,
  MONGODB_URI: process.env.MONGODB_URI,
  DB_NAME: process.env.DB_NAME || "mytripcircle",
  JWT_SECRET: process.env.JWT_SECRET,
  REFRESH_SECRET: process.env.REFRESH_SECRET,
  MAIL_USER: process.env.MAIL_USER,
  MAIL_PASS: process.env.MAIL_PASS,
  API_BASE_URL:
    process.env.API_BASE_URL || "https://mytripcircle-api.enzo-turpin.fr",
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  GOOGLE_PLACES_API_KEY: process.env.GOOGLE_PLACES_API_KEY || "",
  // Bundle ID de l'app iOS — utilisé pour valider l'audience des tokens Apple
  APPLE_APP_ID: process.env.APPLE_APP_ID || null,
  // Secret partagé App Store Connect (Shared Secret) pour valider les reçus IAP
  // Requis uniquement quand IAP_SKIP_VALIDATION=false (production)
  APPLE_SHARED_SECRET: process.env.APPLE_SHARED_SECRET || null,
  // true = bypass validation Apple (dev/test sans compte Apple Developer)
  // false = validation stricte via buy.itunes.apple.com (production)
  IAP_SKIP_VALIDATION: process.env.IAP_SKIP_VALIDATION === "true",
  // URL publique du front web — sert de cible de redirection par défaut
  // (OAuth, retour Stripe Checkout, lien de reset de mot de passe)
  WEB_APP_URL: (process.env.WEB_APP_URL || "").replace(/\/+$/, ""),
  // Domaine des cookies d'authentification. À renseigner uniquement quand le
  // front et l'API sont sur des sous-domaines distincts (ex. ".example.com").
  COOKIE_DOMAIN: process.env.COOKIE_DOMAIN || null,
  // ─── Stripe (paiement web) — absent = checkout web désactivé ───────────────
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || null,
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET || null,
  STRIPE_PRICES,
  // ─── Web Push (VAPID) — absent = push web désactivé ────────────────────────
  VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY || null,
  VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY || null,
  VAPID_SUBJECT: process.env.VAPID_SUBJECT || null,
};
