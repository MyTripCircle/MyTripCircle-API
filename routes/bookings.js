const express = require("express");
const logger = require("../utils/logger");
const { requireAuth } = require("../middleware/auth");
const bookingService = require("../services/bookingService");

const router = express.Router();

const handleResult = (res, result, successStatus = 200) => {
  if (result.error) return res.status(result.status).json({ error: result.error });
  return res.status(successStatus).json(result.booking || result.items || result);
};

// POST /bookings
router.post("/", requireAuth, async (req, res) => {
  try {
    const result = await bookingService.createBooking(req.body, String(req.user._id));
    return handleResult(res, result, 201);
  } catch (e) {
    logger.error("[bookings]", e.message);
    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// GET /bookings
router.get("/", requireAuth, async (req, res) => {
  try {
    const items = await bookingService.getBookingsForUser(String(req.user._id));
    return res.json(items);
  } catch (e) {
    logger.error("[bookings]", e.message);
    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// GET /bookings/trip/:tripId
router.get("/trip/:tripId", requireAuth, async (req, res) => {
  try {
    const result = await bookingService.getBookingsByTripId(req.params.tripId, String(req.user._id));
    return handleResult(res, result);
  } catch (e) {
    logger.error("[bookings]", e.message);
    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// GET /bookings/:id
router.get("/:id", requireAuth, async (req, res) => {
  try {
    const result = await bookingService.getBookingById(req.params.id, String(req.user._id));
    return handleResult(res, result);
  } catch (e) {
    logger.error("[bookings]", e.message);
    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// PUT /bookings/:id
router.put("/:id", requireAuth, async (req, res) => {
  try {
    const result = await bookingService.updateBooking(req.params.id, req.body, String(req.user._id));
    return handleResult(res, result);
  } catch (e) {
    logger.error("[bookings]", e.message);
    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// DELETE /bookings/:id
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const result = await bookingService.deleteBooking(req.params.id, String(req.user._id));
    return handleResult(res, result);
  } catch (e) {
    logger.error("[bookings]", e.message);
    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

module.exports = router;
