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

// Limite stricte pour les endpoints de recherche d'utilisateurs (anti-énumération/scraping)
// 10 requêtes par minute par utilisateur authentifié (ou par IP en fallback)
const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Utilise l'ID utilisateur si disponible (middleware requireAuth doit passer avant)
    const userId = req.user?._id ? String(req.user._id) : null;
    return userId || req.ip || "unknown";
  },
  message: { success: false, error: "Trop de recherches. Réessayez dans une minute." },
});

module.exports = { authLimiter, generalLimiter, searchLimiter };
