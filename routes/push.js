const express = require("express");
const { requireAuth } = require("../middleware/auth");
const logger = require("../utils/logger");
const {
  isWebPushEnabled,
  getPublicKey,
  isValidSubscription,
  saveSubscription,
  removeSubscription,
} = require("../services/pushService");

const router = express.Router();

// GET /users/push/vapid-public-key — clé publique VAPID pour PushManager.subscribe()
// Publique par nature : elle n'autorise que la vérification de la signature d'envoi.
router.get("/push/vapid-public-key", (_req, res) => {
  const publicKey = getPublicKey();
  if (!publicKey) {
    return res.status(503).json({ success: false, error: "Notifications web non configurées" });
  }
  return res.json({ publicKey });
});

// POST /users/push/subscribe — enregistre l'abonnement du navigateur courant
router.post("/push/subscribe", requireAuth, async (req, res) => {
  // Sans clés VAPID, aucun envoi ne partira : inutile de stocker l'abonnement.
  if (!isWebPushEnabled()) {
    return res.status(503).json({ success: false, error: "Notifications web non configurées" });
  }

  try {
    const { subscription } = req.body;
    if (!isValidSubscription(subscription)) {
      return res.status(400).json({ success: false, error: "Abonnement invalide" });
    }

    await saveSubscription(req.user._id, subscription);
    return res.status(204).send();
  } catch (e) {
    logger.error("[push] POST /push/subscribe", e.message);
    return res.status(500).json({ success: false, error: "Erreur interne du serveur" });
  }
});

// DELETE /users/push/subscribe — désinscrit un navigateur (déconnexion, refus)
router.delete("/push/subscribe", requireAuth, async (req, res) => {
  try {
    const { endpoint } = req.body || {};
    if (typeof endpoint !== "string" || endpoint.length === 0) {
      return res.status(400).json({ success: false, error: "Endpoint requis" });
    }

    await removeSubscription(req.user._id, endpoint);
    return res.status(204).send();
  } catch (e) {
    logger.error("[push] DELETE /push/subscribe", e.message);
    return res.status(500).json({ success: false, error: "Erreur interne du serveur" });
  }
});

module.exports = router;
