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

// Limite par utilisateur authentifié (ou par IP en fallback)
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const userId = req.user?._id ? String(req.user._id) : null;
    return userId || req.ip || "unknown";
  },
  validate: { keyGeneratorIpFallback: false },
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
  validate: { keyGeneratorIpFallback: false },
  message: { success: false, error: "Trop de recherches. Réessayez dans une minute." },
});

// Limite stricte pour les endpoints de validation IAP (anti-fraude)
// 10 validations par heure par utilisateur authentifié
const iapLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const userId = req.user?._id ? String(req.user._id) : null;
    return userId || req.ip || "unknown";
  },
  validate: { keyGeneratorIpFallback: false },
  message: { success: false, error: "Trop de tentatives de validation. Réessayez dans une heure." },
});

module.exports = { authLimiter, generalLimiter, searchLimiter, iapLimiter };
