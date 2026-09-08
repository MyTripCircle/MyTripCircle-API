const jwt = require("jsonwebtoken");
const { ObjectId } = require("mongodb");
const { JWT_SECRET } = require("../config");
const { getDb } = require("../db");
const { decryptUserFields } = require("../utils/crypto");
const { readAccessTokenFromCookie } = require("../utils/authCookies");
const logger = require("../utils/logger");

// L'en-tête reste prioritaire : un client mobile ou un appel serveur explicite
// doit pouvoir surcharger un éventuel cookie résiduel du navigateur.
function extractToken(req) {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) return authHeader.split(" ")[1];
  return readAccessTokenFromCookie(req);
}

/**
 * Vérifie le jeton d'accès et attache l'utilisateur courant à la requête.
 *
 * L'utilisateur est relu en base à chaque requête plutôt que reconstitué depuis
 * les revendications du jeton. Le jeton d'accès vit quinze minutes ; s'y fier
 * seul laisserait un compte supprimé, désactivé ou placé en attente de
 * suppression continuer d'agir jusqu'à expiration. Le coût d'une lecture par
 * requête est le prix de cette révocation immédiate.
 *
 * Les champs identifiants sont déchiffrés avant d'être posés sur `req.user`,
 * pour que les routes consommatrices n'aient jamais à connaître la forme
 * persistée ni à manipuler les clés.
 *
 * Tous les échecs — en-tête absent, jeton invalide ou expiré, utilisateur
 * introuvable — répondent le même 401 sans détail. Distinguer ces cas
 * renseignerait un attaquant sur l'existence d'un compte ou sur la validité
 * d'un jeton capturé. Le motif réel n'apparaît qu'en journal serveur.
 *
 * Une exception est ménagée pour l'annulation de suppression : refuser cette
 * route à un compte en attente de suppression rendrait le délai de rétractation
 * inopérant, l'utilisateur ne pouvant plus revenir sur sa demande.
 *
 * @param {import("express").Request} req Requête portant l'en-tête
 *   `Authorization: Bearer <jeton>`.
 * @param {import("express").Response} res Réponse, utilisée pour les refus.
 * @param {import("express").NextFunction} next Passe la main à la suite de la
 *   chaîne une fois `req.user` renseigné.
 * @returns {Promise<void>} Résolue après passage au middleware suivant ou envoi
 *   du refus. N'émet jamais d'erreur : les échecs sont convertis en réponse.
 */
async function requireAuth(req, res, next) {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ success: false, error: "Non autorisé" });
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    const userId = typeof decoded === "string" ? decoded : decoded.id;

    const user = await getDb()
      .collection("users")
      .findOne({ _id: new ObjectId(userId) });

    if (!user) {
      return res.status(401).json({ success: false, error: "Non autorisé" });
    }

    // Autoriser l'accès à cancel-deletion même si le compte est en attente de suppression
    const isCancelDeletion = req.path === "/me/cancel-deletion" && req.method === "POST";
    if (user.pendingDeletion && !isCancelDeletion) {
      return res.status(403).json({
        success: false,
        error: "Compte en cours de suppression",
        pendingDeletion: true,
        deletionScheduledAt: user.deletionScheduledAt,
      });
    }

    req.user = decryptUserFields(user);
    next();
  } catch (e) {
    logger.warn("[auth] Token invalide ou expiré:", e.message);
    return res.status(401).json({ success: false, error: "Non autorisé" });
  }
}

module.exports = { requireAuth, extractToken };
