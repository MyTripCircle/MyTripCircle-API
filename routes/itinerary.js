const express = require("express");
const { getDb } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { GROQ_API_KEY } = require("../config");
const logger = require("../utils/logger");

const router = express.Router();

const DAILY_LIMIT = 10;

// POST /itinerary/generate
router.post("/generate", requireAuth, async (req, res) => {
  try {
    if (!GROQ_API_KEY) {
      return res.status(503).json({ error: "ai_not_configured" });
    }

    const { city, days } = req.body;

    if (!city || typeof city !== "string" || city.trim().length === 0 || city.trim().length > 100) {
      return res.status(400).json({ error: "invalid_city" });
    }
    const daysInt = Number.parseInt(days, 10);
    if (!daysInt || daysInt < 1 || daysInt > 30) {
      return res.status(400).json({ error: "invalid_days" });
    }

    const db = getDb();
    const userId = String(req.user._id);
    const cityNormalized = city.trim().toLowerCase();
    const now = new Date();

    // Rate limiting (10 générations max par 24h)
    const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const usageCount = await db.collection("itinerary_usage").countDocuments({
      userId, createdAt: { $gte: since24h },
    });

    if (usageCount >= DAILY_LIMIT) {
      const oldest = await db.collection("itinerary_usage").findOne(
        { userId, createdAt: { $gte: since24h } },
        { sort: { createdAt: 1 } }
      );
      const resetIn = oldest
        ? Math.ceil((new Date(oldest.createdAt.getTime() + 24 * 60 * 60 * 1000).getTime() - now.getTime()) / 1000)
        : 0;
      return res.status(429).json({ error: "daily_limit_reached", limit: DAILY_LIMIT, resetIn });
    }

    // Cache 7 jours
    const cached = await db.collection("itinerary_cache").findOne({
      city: cityNormalized,
      days: daysInt,
      createdAt: { $gte: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) },
    });

    if (cached) return res.json({ cached: true, itinerary: cached.itinerary });

    const cityClean = city.trim().replace(/["\\\n\r]/g, " ");
    const prompt = `Génère un itinéraire de voyage pour la ville "${cityClean}" sur ${daysInt} jour(s).
Réponds UNIQUEMENT avec un objet JSON valide respectant EXACTEMENT cette structure :
{
  "city": "nom de la ville",
  "days": [
    {
      "day": 1,
      "title": "Titre du jour",
      "morning": { "activity": "Description de l'activité du matin", "tip": "Conseil pratique" },
      "afternoon": { "activity": "Description de l'activité de l'après-midi", "tip": "Conseil pratique" },
      "evening": { "activity": "Description de l'activité du soir", "tip": "Conseil pratique" }
    }
  ]
}
Rédige en français. Ne mets rien avant ou après le JSON.`;

    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.7,
        response_format: { type: "json_object" },
      }),
    });

    const groqData = await groqRes.json();
    const rawText = groqData?.choices?.[0]?.message?.content;

    if (!rawText) {
      return res.status(500).json({ error: "parse_error" });
    }

    let parsedData;
    try {
      const start = rawText.indexOf("{");
      const end = rawText.lastIndexOf("}");
      if (start === -1 || end === -1 || end <= start) throw new Error("Aucun objet JSON trouvé");
      parsedData = JSON.parse(rawText.slice(start, end + 1));
    } catch {
      return res.status(500).json({ error: "parse_error" });
    }

    try {
      await Promise.all([
        db.collection("itinerary_cache").insertOne({
          city: cityNormalized, days: daysInt, itinerary: parsedData, createdAt: new Date(),
        }),
        db.collection("itinerary_usage").insertOne({
          userId, city: cityNormalized, days: daysInt, createdAt: new Date(),
        }),
      ]);
    } catch (cacheErr) {
      logger.error("[itinerary] Erreur lors de l'écriture en cache :", cacheErr.message);
    }

    return res.json({ cached: false, itinerary: parsedData });
  } catch (e) {
    logger.error("[itinerary]", e.message);
    return res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

module.exports = router;
