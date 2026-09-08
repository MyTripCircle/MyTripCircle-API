/**
 * Terminaison de la chaîne Express : conversion des erreurs et des routes
 * inconnues en réponses JSON.
 *
 * Les deux middlewares se montent en dernier dans `app.use()`, {@link notFound}
 * avant {@link errorHandler} : Express ne reconnaît un gestionnaire d'erreurs
 * qu'à son arité de quatre paramètres, et ne lui donne la main qu'après avoir
 * épuisé les middlewares ordinaires.
 *
 * @module middleware/errorHandler
 */

const logger = require("../utils/logger");

/**
 * Journalise l'erreur puis répond au client dans le format uniforme de l'API.
 *
 * Le message d'origine n'est restitué que pour les erreurs portant un statut
 * explicite, c'est-à-dire celles que le code a délibérément formulées à
 * destination du client. Toute erreur sans statut est traitée comme
 * inattendue : son message est remplacé par un libellé générique, car il peut
 * exposer un chemin de fichier, une requête ou un fragment de configuration.
 * Le détail complet reste en journal serveur, seul endroit où il est utile.
 *
 * La signature conserve `_next` inutilisé : le retirer ramènerait l'arité à
 * trois et Express traiterait la fonction comme un middleware ordinaire, qui ne
 * serait jamais appelé sur erreur.
 *
 * @param {Error & { status?: number }} err Erreur propagée, `status` portant le
 *   code HTTP lorsqu'il s'agit d'une erreur métier.
 * @param {import("express").Request} req Requête à l'origine de l'erreur.
 * @param {import("express").Response} res Réponse à émettre.
 * @param {import("express").NextFunction} _next Requis par Express pour
 *   identifier un gestionnaire d'erreurs ; volontairement inutilisé.
 * @returns {void}
 */
function errorHandler(err, req, res, _next) {
  logger.error(`[error] ${req.method} ${req.path}:`, err.message);
  const status = err.status || 500;
  res.status(status).json({
    success: false,
    error: status === 500 ? "Erreur interne du serveur" : err.message,
  });
}

/**
 * Répond aux requêtes qu'aucune route n'a prises en charge.
 *
 * Sans lui, Express émettrait sa page HTML par défaut, incohérente avec le
 * format JSON attendu par le client et porteuse d'une pile d'appels hors
 * production.
 *
 * @param {import("express").Request} req Requête non appariée.
 * @param {import("express").Response} res Réponse à émettre.
 * @returns {void}
 */
function notFound(req, res) {
  res.status(404).json({ success: false, error: "Route introuvable" });
}

module.exports = { errorHandler, notFound };
