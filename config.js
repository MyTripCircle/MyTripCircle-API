// Validation des variables d'environnement au démarrage
const REQUIRED_VARS = ["MONGODB_URI", "JWT_SECRET"];

function validateEnv() {
  const missing = REQUIRED_VARS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.error(
      `[config] Variables d'environnement manquantes : ${missing.join(", ")}`
    );
    process.exit(1);
  }

  if (process.env.JWT_SECRET === "dev-secret-change-me") {
    console.warn(
      "[config] AVERTISSEMENT : JWT_SECRET est encore la valeur par défaut. Changez-la en production."
    );
  }
}

module.exports = {
  validateEnv,
  PORT: process.env.API_PORT ? parseInt(process.env.API_PORT, 10) : 4000,
  MONGODB_URI: process.env.MONGODB_URI,
  DB_NAME: process.env.DB_NAME || "mytripcircle",
  JWT_SECRET: process.env.JWT_SECRET,
  MAIL_USER: process.env.MAIL_USER,
  MAIL_PASS: process.env.MAIL_PASS,
  API_BASE_URL:
    process.env.API_BASE_URL || "https://mytripcircle-api.enzo-turpin.fr",
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  // Bundle ID de l'app iOS — utilisé pour valider l'audience des tokens Apple
  APPLE_APP_ID: process.env.APPLE_APP_ID || null,
};
