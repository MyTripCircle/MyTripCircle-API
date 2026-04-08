// Gestionnaire d'erreurs centralisé — à monter EN DERNIER dans app.use()
const logger = require("../utils/logger");

function errorHandler(err, req, res, _next) {
  logger.error(`[error] ${req.method} ${req.path}:`, err.message);
  const status = err.status || 500;
  res.status(status).json({
    success: false,
    error: status === 500 ? "Erreur interne du serveur" : err.message,
  });
}

// Middleware pour les routes introuvables
function notFound(req, res) {
  res.status(404).json({ success: false, error: "Route introuvable" });
}

module.exports = { errorHandler, notFound };
