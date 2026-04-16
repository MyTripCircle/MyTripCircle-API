const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { GOOGLE_PLACES_API_KEY } = require("../config");
const logger = require("../utils/logger");

const router = express.Router();

const BASE = "https://maps.googleapis.com/maps/api/place";

// GET /places/autocomplete
router.get("/autocomplete", requireAuth, async (req, res) => {
  try {
    const { input, language = "fr", location, radius, types } = req.query;
    if (!input || typeof input !== "string" || !input.trim()) {
      return res.json({ predictions: [] });
    }

    const params = new URLSearchParams({ input: input.trim(), key: GOOGLE_PLACES_API_KEY, language });
    if (location) params.set("location", location);
    if (radius) params.set("radius", radius);
    if (types) params.set("types", types);

    const upstream = await fetch(`${BASE}/autocomplete/json?${params}`);
    const data = await upstream.json();

    if (data.status === "ZERO_RESULTS") return res.json({ predictions: [] });
    if (data.status !== "OK") {
      logger.warn(`[places] autocomplete status: ${data.status}`);
      return res.status(502).json({ error: `Places API: ${data.status}` });
    }

    return res.json({ predictions: data.predictions || [] });
  } catch (e) {
    logger.error("[places] autocomplete:", e.message);
    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// GET /places/details
router.get("/details", requireAuth, async (req, res) => {
  try {
    const { placeId, language = "fr" } = req.query;
    if (!placeId || typeof placeId !== "string") {
      return res.status(400).json({ error: "placeId requis" });
    }

    const params = new URLSearchParams({
      place_id: placeId,
      key: GOOGLE_PLACES_API_KEY,
      fields: "formatted_address,address_component,name,rating,formatted_phone_number,website,photos",
      language,
    });

    const upstream = await fetch(`${BASE}/details/json?${params}`);
    const data = await upstream.json();

    if (data.status !== "OK") {
      logger.warn(`[places] details status: ${data.status}`);
      return res.status(502).json({ error: `Places API: ${data.status}` });
    }

    // Remplace la référence photo par une URL proxifiée (sans exposer la clé)
    const result = data.result || {};
    const firstPhotoRef = result.photos?.[0]?.photo_reference;
    const photoUrl = firstPhotoRef ? `/places/photo?ref=${encodeURIComponent(firstPhotoRef)}&maxwidth=800` : undefined;

    return res.json({ result: { ...result, photoUrl, photos: undefined } });
  } catch (e) {
    logger.error("[places] details:", e.message);
    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// GET /places/textsearch
router.get("/textsearch", requireAuth, async (req, res) => {
  try {
    const { query, language = "fr" } = req.query;
    if (!query || typeof query !== "string" || !query.trim()) {
      return res.json({ results: [] });
    }

    const params = new URLSearchParams({ query: query.trim(), key: GOOGLE_PLACES_API_KEY, language });

    const upstream = await fetch(`${BASE}/textsearch/json?${params}`);
    const data = await upstream.json();

    logger.info(`[places] textsearch — status: ${data.status}${data.error_message ? ` | ${data.error_message}` : ""} | query: "${query}"`);
    if (data.status === "ZERO_RESULTS") return res.json({ results: [] });
    if (data.status !== "OK") {
      return res.status(502).json({ error: `Places API: ${data.status}`, detail: data.error_message });
    }
    if (!data.results?.length) return res.json({ results: [] });

    const results = data.results.map((place) => {
      const photoRef = place.photos?.[0]?.photo_reference;
      return {
        place_id: place.place_id,
        name: place.name || "",
        formatted_address: place.formatted_address || "",
        rating: typeof place.rating === "number" ? place.rating : undefined,
        photoUrl: photoRef ? `/places/photo?ref=${encodeURIComponent(photoRef)}&maxwidth=800` : undefined,
      };
    });

    return res.json({ results });
  } catch (e) {
    logger.error("[places] textsearch:", e.message);
    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// GET /places/photo — proxy public (la photo_reference expire, pas besoin d'auth)
router.get("/photo", async (req, res) => {
  try {
    const { ref, maxwidth = "800" } = req.query;
    if (!ref || typeof ref !== "string") {
      return res.status(400).json({ error: "ref requis" });
    }

    const params = new URLSearchParams({
      photoreference: ref,
      maxwidth: String(maxwidth),
      key: GOOGLE_PLACES_API_KEY,
    });

    const upstream = await fetch(`${BASE}/photo?${params}`);
    if (!upstream.ok) return res.status(upstream.status).end();

    const contentType = upstream.headers.get("content-type") || "image/jpeg";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");

    const buffer = await upstream.arrayBuffer();
    return res.send(Buffer.from(buffer));
  } catch (e) {
    logger.error("[places] photo:", e.message);
    return res.status(500).end();
  }
});

module.exports = router;
