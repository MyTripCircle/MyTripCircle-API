const Amadeus = require("amadeus");
const { getDb } = require("../db");
const logger = require("../utils/logger");

let client = null;

function getClient() {
  if (!client) {
    const clientId = process.env.AMADEUS_API_KEY;
    const clientSecret = process.env.AMADEUS_API_SECRET;

    if (!clientId || !clientSecret) {
      throw new Error("amadeus_not_configured");
    }

    client = new Amadeus({
      clientId,
      clientSecret,
      hostname: process.env.AMADEUS_ENV === "production" ? "production" : "test",
    });
  }
  return client;
}

// ─── Vols ─────────────────────────────────────────────────────────────────────

async function searchFlights({ origin, destination, departureDate, returnDate, adults = 1, currencyCode = "EUR", max = 10 }) {
  const db = getDb();
  const cacheKey = `flights:${origin}:${destination}:${departureDate}:${returnDate ?? ""}:${adults}:${currencyCode}`;

  const cached = await db.collection("amadeus_cache").findOne({
    key: cacheKey,
    createdAt: { $gte: new Date(Date.now() - 6 * 60 * 60 * 1000) }, // TTL 6h
  });

  if (cached) {
    logger.debug(`[amadeus] cache hit flights — ${cacheKey}`);
    return { cached: true, data: cached.data };
  }

  const params = {
    originLocationCode: origin,
    destinationLocationCode: destination,
    departureDate,
    adults: String(adults),
    currencyCode,
    max: String(max),
  };
  if (returnDate) params.returnDate = returnDate;

  const response = await getClient().shopping.flightOffersSearch.get(params);
  const data = formatFlights(response.data);

  await db.collection("amadeus_cache").insertOne({ key: cacheKey, data, createdAt: new Date() });

  return { cached: false, data };
}

function formatFlights(raw) {
  return raw.map((offer) => ({
    id: offer.id,
    price: {
      total: offer.price?.total,
      currency: offer.price?.currency,
    },
    itineraries: offer.itineraries?.map((itin) => ({
      duration: itin.duration,
      segments: itin.segments?.map((seg) => ({
        departure: { iataCode: seg.departure?.iataCode, at: seg.departure?.at },
        arrival: { iataCode: seg.arrival?.iataCode, at: seg.arrival?.at },
        carrier: seg.carrierCode,
        flightNumber: `${seg.carrierCode}${seg.number}`,
        duration: seg.duration,
        numberOfStops: seg.numberOfStops ?? 0,
      })),
    })),
    numberOfBookableSeats: offer.numberOfBookableSeats,
    lastTicketingDate: offer.lastTicketingDate,
  }));
}

// ─── Hôtels ───────────────────────────────────────────────────────────────────

async function searchHotels({ cityCode, checkInDate, checkOutDate, adults = 1, currencyCode = "EUR" }) {
  const db = getDb();
  const cacheKey = `hotels:${cityCode}:${checkInDate}:${checkOutDate}:${adults}:${currencyCode}`;

  const cached = await db.collection("amadeus_cache").findOne({
    key: cacheKey,
    createdAt: { $gte: new Date(Date.now() - 6 * 60 * 60 * 1000) },
  });

  if (cached) {
    logger.debug(`[amadeus] cache hit hotels — ${cacheKey}`);
    return { cached: true, data: cached.data };
  }

  // Étape 1 — liste des hôtels de la ville (max 20 pour les offres ensuite)
  const listRes = await getClient().referenceData.locations.hotels.byCity.get({
    cityCode,
  });

  const hotelIds = listRes.data?.slice(0, 20).map((h) => h.hotelId) ?? [];

  if (!hotelIds.length) {
    return { cached: false, data: [] };
  }

  // Étape 2 — disponibilités et prix
  const offersRes = await getClient().shopping.hotelOffersSearch.get({
    hotelIds: hotelIds.join(","),
    checkInDate,
    checkOutDate,
    adults: String(adults),
    currencyCode,
    bestRateOnly: true,
  });

  const data = formatHotels(offersRes.data);

  await db.collection("amadeus_cache").insertOne({ key: cacheKey, data, createdAt: new Date() });

  return { cached: false, data };
}

function formatHotels(raw) {
  return raw.map((item) => ({
    hotelId: item.hotel?.hotelId,
    name: item.hotel?.name,
    cityCode: item.hotel?.cityCode,
    latitude: item.hotel?.latitude,
    longitude: item.hotel?.longitude,
    offer: item.offers?.[0]
      ? {
          id: item.offers[0].id,
          checkInDate: item.offers[0].checkInDate,
          checkOutDate: item.offers[0].checkOutDate,
          price: {
            total: item.offers[0].price?.total,
            currency: item.offers[0].price?.currency,
          },
          roomType: item.offers[0].room?.typeEstimated?.category,
          beds: item.offers[0].room?.typeEstimated?.beds,
        }
      : null,
  }));
}

// ─── Analyse de prix ──────────────────────────────────────────────────────────

async function analyzePriceMetrics({ origin, destination, departureDate, currencyCode = "EUR", oneWay = true }) {
  const db = getDb();
  const cacheKey = `price-metrics:${origin}:${destination}:${departureDate}:${currencyCode}`;

  const cached = await db.collection("amadeus_cache").findOne({
    key: cacheKey,
    createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }, // TTL 24h — les métriques varient moins
  });

  if (cached) {
    logger.debug(`[amadeus] cache hit price-metrics — ${cacheKey}`);
    return { cached: true, data: cached.data };
  }

  const response = await getClient().analytics.itineraryPriceMetrics.get({
    originIataCode: origin,
    destinationIataCode: destination,
    departureDate,
    currencyCode,
    oneWay: String(oneWay),
  });

  const data = response.data ?? [];
  await db.collection("amadeus_cache").insertOne({ key: cacheKey, data, createdAt: new Date() });

  return { cached: false, data };
}

module.exports = { searchFlights, searchHotels, analyzePriceMetrics };
