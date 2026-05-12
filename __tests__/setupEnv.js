// Variables d'environnement minimales pour exécuter les modules serveur en test.
// Chargé via `setupFiles` (donc avant le require des modules par les fichiers de test)
// pour que server/config.js puisse lire ses constantes.
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.JWT_SECRET = "test-jwt-secret";
process.env.REFRESH_SECRET = "test-refresh-secret";
// 32 octets en hexadécimal (64 caractères) — clés factices réservées aux tests
process.env.ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.HMAC_KEY =
  "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
process.env.MONGODB_URI = "mongodb://localhost:27017/mytripcircle-test";
