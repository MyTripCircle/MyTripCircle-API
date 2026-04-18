const express = require("express");
const crypto = require("node:crypto");
const rateLimit = require("express-rate-limit");
const ical = require("ical-generator");
const { getDb } = require("../db");
const logger = require("../utils/logger");

const router = express.Router();

const calendarLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip || "unknown",
  validate: { keyGeneratorIpFallback: false },
  message: "Trop de requêtes.",
});

function buildEventDescription(booking, tripMap) {
  const trip = booking.tripId ? tripMap[booking.tripId] : null;
  const tripLine = trip?.title || trip?.destination
    ? `Voyage : ${trip.title || trip.destination}`
    : null;
  const confirmLine = booking.confirmationNumber
    ? `N° confirmation : ${booking.confirmationNumber}`
    : null;
  return [tripLine, confirmLine, booking.description || null].filter(Boolean).join("\n");
}

function addBookingsToCalendar(calendar, bookings, tripMap) {
  for (const booking of bookings) {
    if (!booking.date) continue;
    const start = new Date(booking.date);
    const end = booking.endDate
      ? new Date(booking.endDate)
      : new Date(start.getTime() + 60 * 60 * 1000);
    // uid déterministe : même booking → même UID entre les synchronisations
    const uid = crypto
      .createHash("sha256")
      .update(String(booking._id))
      .digest("hex")
      .slice(0, 32)
      .concat("@mytripcircle");
    const description = buildEventDescription(booking, tripMap);
    calendar.createEvent({
      id: uid,
      summary: booking.title || booking.type || "Réservation",
      description: description || undefined,
      location: booking.address || undefined,
      start,
      end,
    });
  }
}

// GET /calendar/:token — flux iCal public (synchronisation native iOS/Android)
router.get("/:token", calendarLimiter, async (req, res) => {
  try {
    const db = getDb();
    const { token } = req.params;

    if (!token || !/^[0-9a-f]{64}$/.test(token)) {
      return res.status(404).end();
    }

    const user = await db.collection("users").findOne({ calendarToken: token });
    if (!user) return res.status(404).end();

    const userId = String(user._id);

    const sub = await db.collection("subscriptions").findOne({ userId });
    const isPremium =
      sub?.status === "active" && sub?.endDate && new Date(sub.endDate) > new Date();
    if (!isPremium) return res.status(403).end();

    const userTrips = await db
      .collection("trips")
      .find({ $or: [{ ownerId: userId }, { "collaborators.userId": userId }] })
      .toArray();

    const tripIds = userTrips.map((t) => String(t._id));
    const tripMap = Object.fromEntries(userTrips.map((t) => [String(t._id), t]));

    const bookings = await db
      .collection("bookings")
      .find({
        $or: [
          { tripId: { $in: tripIds } },
          { userId, tripId: { $in: ["", null] } },
          { userId, tripId: { $exists: false } },
        ],
        status: { $ne: "cancelled" },
      })
      .toArray();

    const calendar = ical.default({ name: "MyTripCircle", timezone: "UTC" });
    addBookingsToCalendar(calendar, bookings, tripMap);

    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="mytripcircle.ics"');
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    return res.send(calendar.toString());
  } catch (e) {
    logger.error("[calendar] GET /:token", e.message);
    return res.status(500).end();
  }
});

module.exports = router;
