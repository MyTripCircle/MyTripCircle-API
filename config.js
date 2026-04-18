// Validation des variables d'environnement au démarrage
const REQUIRED_VARS = ["MONGODB_URI", "JWT_SECRET", "REFRESH_SECRET", "ENCRYPTION_KEY", "HMAC_KEY"];

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
  IAP_SKIP_VALIDATION: process.env.IAP_SKIP_VALIDATION !== "false",
};
