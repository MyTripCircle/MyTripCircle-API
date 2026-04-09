const express = require("express");
const logger = require("../utils/logger");
const { requireAuth } = require("../middleware/auth");
const tripService = require("../services/tripService");

const router = express.Router();

const handleResult = (res, result, successStatus = 200) => {
  if (result.error) return res.status(result.status).json({ error: result.error });
  return res.status(successStatus).json(result.trip || result);
};

// GET /trips
router.get("/", requireAuth, async (req, res) => {
  try {
    const items = await tripService.getTripsForUser(String(req.user._id));
    return res.json(items);
  } catch (e) {
    logger.error("[trips]", e.message);
    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// GET /trips/:id
router.get("/:id", requireAuth, async (req, res) => {
  try {
    const result = await tripService.getTripById(req.params.id, String(req.user._id));
    return handleResult(res, result);
  } catch (e) {
    logger.error("[trips]", e.message);
    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// POST /trips
router.post("/", requireAuth, async (req, res) => {
  try {
    const result = await tripService.createTrip(req.body, String(req.user._id));
    return handleResult(res, result, 201);
  } catch (e) {
    logger.error("[trips]", e.message);
    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// PUT /trips/:id
router.put("/:id", requireAuth, async (req, res) => {
  try {
    const result = await tripService.updateTrip(req.params.id, req.body, String(req.user._id));
    return handleResult(res, result);
  } catch (e) {
    logger.error("[trips]", e.message);
    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// DELETE /trips/:id
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const result = await tripService.deleteTrip(req.params.id, String(req.user._id));
    return handleResult(res, result);
  } catch (e) {
    logger.error("[trips]", e.message);
    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// DELETE /trips/:id/collaborators/:userId
router.delete("/:id/collaborators/:userId", requireAuth, async (req, res) => {
  try {
    const result = await tripService.removeTripCollaborator(
      req.params.id, req.params.userId, String(req.user._id)
    );
    return handleResult(res, result);
  } catch (e) {
    logger.error("[trips]", e.message);
    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// PUT /trips/:id/transfer-ownership
router.put("/:id/transfer-ownership", requireAuth, async (req, res) => {
  try {
    const result = await tripService.transferTripOwnership(
      req.params.id, req.body.newOwnerId, String(req.user._id)
    );
    return handleResult(res, result);
  } catch (e) {
    logger.error("[trips]", e.message);
    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

module.exports = router;
