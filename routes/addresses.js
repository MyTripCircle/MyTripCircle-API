const express = require("express");
const logger = require("../utils/logger");
const { requireAuth } = require("../middleware/auth");
const addressService = require("../services/addressService");

const router = express.Router();

const handleResult = (res, result, successStatus = 200) => {
  if (result.error) return res.status(result.status).json({ error: result.error });
  return res.status(successStatus).json(result.item || result.items || result);
};

// GET /addresses
router.get("/", requireAuth, async (req, res) => {
  try {
    const items = await addressService.getAddressesForUser(String(req.user._id));
    return res.json(items);
  } catch (e) {
    logger.error("[addresses]", e.message);
    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// GET /addresses/trip/:tripId
router.get("/trip/:tripId", requireAuth, async (req, res) => {
  try {
    const result = await addressService.getAddressesByTripId(req.params.tripId, String(req.user._id));
    return handleResult(res, result);
  } catch (e) {
    logger.error("[addresses]", e.message);
    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// GET /addresses/:id
router.get("/:id", requireAuth, async (req, res) => {
  try {
    const result = await addressService.getAddressById(req.params.id, String(req.user._id));
    return handleResult(res, result);
  } catch (e) {
    logger.error("[addresses]", e.message);
    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// POST /addresses
router.post("/", requireAuth, async (req, res) => {
  try {
    const result = await addressService.createAddress(req.body, String(req.user._id));
    return handleResult(res, result, 201);
  } catch (e) {
    logger.error("[addresses]", e.message);
    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// PUT /addresses/:id
router.put("/:id", requireAuth, async (req, res) => {
  try {
    const result = await addressService.updateAddress(req.params.id, req.body, String(req.user._id));
    return handleResult(res, result);
  } catch (e) {
    logger.error("[addresses]", e.message);
    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// DELETE /addresses/:id
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const result = await addressService.deleteAddress(req.params.id, String(req.user._id));
    return handleResult(res, result);
  } catch (e) {
    logger.error("[addresses]", e.message);
    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

module.exports = router;
