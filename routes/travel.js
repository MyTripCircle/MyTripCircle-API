const express = require("express");
const { requireAuth } = require("../middleware/auth");
const logger = require("../utils/logger");
const { searchFlights, searchHotels, analyzePriceMetrics } = require("../services/amadeusService");

const router = express.Router();

const IATA_REGEX = /^[A-Z]{3}$/;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function isValidIata(code) {
  return typeof code === "string" && IATA_REGEX.test(code);
}

function isValidDate(date) {
  if (typeof date !== "string" || !DATE_REGEX.test(date)) return false;
  const d = new Date(date);
  return !Number.isNaN(d.getTime()) && d >= new Date(new Date().toISOString().slice(0, 10));
}

// GET /travel/flights
router.get("/flights", requireAuth, async (req, res) => {
  try {
    const { origin, destination, departureDate, returnDate, adults, currencyCode } = req.query;

    if (!isValidIata(origin)) return res.status(400).json({ error: "origin_invalid", detail: "Code IATA 3 lettres majuscules requis" });
    if (!isValidIata(destination)) return res.status(400).json({ error: "destination_invalid", detail: "Code IATA 3 lettres majuscules requis" });
    if (!isValidDate(departureDate)) return res.status(400).json({ error: "departureDate_invalid", detail: "Format YYYY-MM-DD requis, date future" });
    if (returnDate && !isValidDate(returnDate)) return res.status(400).json({ error: "returnDate_invalid", detail: "Format YYYY-MM-DD requis, date future" });

    const adultsInt = adults ? Number.parseInt(adults, 10) : 1;
    if (Number.isNaN(adultsInt) || adultsInt < 1 || adultsInt > 9) {
      return res.status(400).json({ error: "adults_invalid", detail: "Entre 1 et 9" });
    }

    const result = await searchFlights({
      origin,
      destination,
      departureDate,
      returnDate,
      adults: adultsInt,
      currencyCode: currencyCode || "EUR",
    });

    return res.json(result);
  } catch (e) {
    if (e.message === "amadeus_not_configured") {
      return res.status(503).json({ error: "amadeus_not_configured" });
    }
    logger.error("[travel] /flights:", e.message);
    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// GET /travel/hotels
router.get("/hotels", requireAuth, async (req, res) => {
  try {
    const { cityCode, checkInDate, checkOutDate, adults, currencyCode } = req.query;

    if (!isValidIata(cityCode)) return res.status(400).json({ error: "cityCode_invalid", detail: "Code IATA 3 lettres majuscules requis" });
    if (!isValidDate(checkInDate)) return res.status(400).json({ error: "checkInDate_invalid", detail: "Format YYYY-MM-DD requis, date future" });
    if (!isValidDate(checkOutDate)) return res.status(400).json({ error: "checkOutDate_invalid", detail: "Format YYYY-MM-DD requis, date future" });

    const checkIn = new Date(checkInDate);
    const checkOut = new Date(checkOutDate);
    if (checkOut <= checkIn) return res.status(400).json({ error: "dates_invalid", detail: "checkOutDate doit être après checkInDate" });

    const adultsInt = adults ? Number.parseInt(adults, 10) : 1;
    if (Number.isNaN(adultsInt) || adultsInt < 1 || adultsInt > 9) {
      return res.status(400).json({ error: "adults_invalid", detail: "Entre 1 et 9" });
    }

    const result = await searchHotels({
      cityCode,
      checkInDate,
      checkOutDate,
      adults: adultsInt,
      currencyCode: currencyCode || "EUR",
    });

    return res.json(result);
  } catch (e) {
    if (e.message === "amadeus_not_configured") {
      return res.status(503).json({ error: "amadeus_not_configured" });
    }
    logger.error("[travel] /hotels:", e.message);
    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// GET /travel/price-analysis
router.get("/price-analysis", requireAuth, async (req, res) => {
  try {
    const { origin, destination, departureDate, currencyCode, oneWay } = req.query;

    if (!isValidIata(origin)) return res.status(400).json({ error: "origin_invalid", detail: "Code IATA 3 lettres majuscules requis" });
    if (!isValidIata(destination)) return res.status(400).json({ error: "destination_invalid", detail: "Code IATA 3 lettres majuscules requis" });
    if (!isValidDate(departureDate)) return res.status(400).json({ error: "departureDate_invalid", detail: "Format YYYY-MM-DD requis, date future" });

    const result = await analyzePriceMetrics({
      origin,
      destination,
      departureDate,
      currencyCode: currencyCode || "EUR",
      oneWay: oneWay !== "false",
    });

    return res.json(result);
  } catch (e) {
    if (e.message === "amadeus_not_configured") {
      return res.status(503).json({ error: "amadeus_not_configured" });
    }
    logger.error("[travel] /price-analysis:", e.message);
    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

module.exports = router;
