/**
 * Limiteurs de débit, gradués selon ce que la route expose.
 *
 * Un seul limiteur global ne conviendrait pas : les plafonds sont dictés par le
 * coût d'un abus, non par la charge serveur. Cinq essais par quart d'heure sur
 * l'authentification, mille par minute sur le reste — l'écart mesure la
 * différence entre une route dont l'abus compromet un compte et une route dont
 * l'abus ne coûte que des ressources.
 *
 * Le comptage se fait par utilisateur authentifié dès que possible, et par
 * adresse IP à défaut. Compter par IP seule pénaliserait indistinctement tous
 * les utilisateurs derrière un même réseau d'entreprise ou une même passerelle
 * mobile, tout en laissant un attaquant disposant de plusieurs adresses
 * multiplier son quota d'autant.
 *
 * @module middleware/rateLimiter
 */

const rateLimit = require("express-rate-limit");

/**
 * Limiteur des routes d'authentification, opposé aux attaques par force brute.
 *
 * Le comptage porte sur l'adresse IP et non sur l'utilisateur : à ce stade
 * aucune identité n'est encore établie, et se fier à un identifiant fourni par
 * le client permettrait à un attaquant de le faire varier pour repartir d'un
 * compteur neuf.
 *
 * `skipSuccessfulRequests` fait que seuls les échecs sont décomptés. Sans cela,
 * un utilisateur légitime qui se reconnecte plusieurs fois dans le quart
 * d'heure épuiserait son quota, alors que la seule chose à contenir est la
 * répétition d'essais infructueux.
 *
 * @type {import("express").RequestHandler}
 */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  skipSuccessfulRequests: true, // Ne compte que les échecs
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Trop de tentatives. Réessayez dans 15 minutes." },
});

/**
 * Limiteur de fond appliqué à l'ensemble de l'API.
 *
 * Le plafond est délibérément haut : il ne vise pas l'abus ciblé, déjà couvert
 * par les limiteurs spécialisés, mais l'emballement — client en boucle de
 * reprise, requêtes dupliquées — que rien d'autre n'arrêterait. Un seuil bas
 * ici gênerait la navigation normale sans rien apporter contre un attaquant
 * discipliné.
 *
 * `keyGeneratorIpFallback` est désactivé parce que le repli sur l'adresse IP
 * est déjà assuré explicitement dans `keyGenerator` ; laisser la validation
 * active produirait un avertissement sur un comportement voulu.
 *
 * @type {import("express").RequestHandler}
 */
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

/**
 * Limiteur des routes de recherche d'utilisateurs, opposé à l'énumération.
 *
 * Ces routes répondent nécessairement par l'affirmative ou la négative sur
 * l'existence d'un compte, ce qui en fait un moyen de reconstituer l'annuaire
 * par interrogations successives. Le chiffrement des adresses ne protège pas de
 * cet abus, qui passe par l'interface légitime et non par la base. Dix requêtes
 * par minute suffisent à un usage humain et rendent le balayage impraticable.
 *
 * Suppose `requireAuth` monté en amont, sans quoi le comptage retombe sur
 * l'adresse IP et le quota se contourne en changeant de réseau.
 *
 * @type {import("express").RequestHandler}
 */
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

/**
 * Limiteur des routes de validation d'achat intégré, opposé à la fraude.
 *
 * Chaque validation déclenche un appel sortant vers la boutique applicative,
 * facturé et lui-même soumis à quota côté fournisseur ; la répétition permet en
 * outre de tester des reçus falsifiés jusqu'à en trouver un accepté. La fenêtre
 * horaire est calée sur l'usage réel : une validation d'achat est un événement
 * rare, dix par heure couvrent largement les reprises après incident réseau.
 *
 * @type {import("express").RequestHandler}
 */
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
