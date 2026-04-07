const rateLimit = require("express-rate-limit");

// Limite stricte pour les endpoints d'authentification (brute force)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Trop de tentatives. Réessayez dans 15 minutes." },
});

// Limite standard pour les endpoints publics
const generalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Trop de requêtes. Ralentissez." },
});

module.exports = { authLimiter, generalLimiter };
