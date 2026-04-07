const rateLimit = require("express-rate-limit");

// Limite stricte pour les endpoints d'authentification (brute force)
// 5 tentatives échouées par 15 minutes par IP
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  skipSuccessfulRequests: true, // Ne compte que les échecs
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Trop de tentatives. Réessayez dans 15 minutes." },
});

// Limite standard pour les endpoints authentifiés
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Trop de requêtes. Ralentissez." },
});

module.exports = { authLimiter, generalLimiter };
