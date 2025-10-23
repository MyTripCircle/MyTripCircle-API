// Simple Express API (JS) for Expo dev
const express = require("express");
const cors = require("cors");
const { MongoClient } = require("mongodb");
const os = require("os");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.API_PORT ? parseInt(process.env.API_PORT, 10) : 4000;
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || "mytripcircle";

// IP depuis .env ou détection automatique
const ACTIVE_IP =
  process.env.API_IP_PRIMARY ||
  (() => {
    console.log(
      "[server] API_IP_PRIMARY not set, detecting IP automatically..."
    );
    const interfaces = os.networkInterfaces();
    const priorityInterfaces = ["Wi-Fi", "Ethernet", "en0", "eth0"];

    for (const interfaceName of priorityInterfaces) {
      if (interfaces[interfaceName]) {
        for (const iface of interfaces[interfaceName]) {
          if (iface.family === "IPv4" && !iface.internal) {
            return iface.address;
          }
        }
      }
    }

    // Fallback: première IP non-internale
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === "IPv4" && !iface.internal) {
          return iface.address;
        }
      }
    }

    return "localhost";
  })();

let db;

async function connectMongo() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db(DB_NAME);
  console.log(`[server] Connected to MongoDB: ${DB_NAME}`);
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/test", (req, res) => {
  res.status(200).json({
    message: "Backend is working!",
    timestamp: new Date().toISOString(),
    trips: "Use /trips endpoint",
    bookings: "Use /bookings endpoint",
    addresses: "Use /addresses endpoint",
  });
});

app.get("/trips", async (_req, res) => {
  try {
    const items = await db.collection("trips").find({}).toArray();
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/trips/:id", async (req, res) => {
  try {
    const item = await db.collection("trips").findOne({ _id: req.params.id });
    if (!item) return res.status(404).json({ error: "Not found" });
    res.json(item);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/bookings", async (_req, res) => {
  try {
    const items = await db.collection("bookings").find({}).toArray();
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/bookings/trip/:tripId", async (req, res) => {
  try {
    const items = await db
      .collection("bookings")
      .find({ tripId: req.params.tripId })
      .toArray();
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/addresses", async (_req, res) => {
  try {
    const items = await db.collection("addresses").find({}).toArray();
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/addresses/trip/:tripId", async (req, res) => {
  try {
    const items = await db
      .collection("addresses")
      .find({ tripId: req.params.tripId })
      .toArray();
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

connectMongo()
  .then(() => {
    app.listen(PORT, ACTIVE_IP, () => {
      console.log(`[server] API listening on http://${ACTIVE_IP}:${PORT}`);
      console.log(`[server] Accessible via http://localhost:${PORT}`);
      console.log(`[server] Use this IP in your app: ${ACTIVE_IP}`);
    });
  })
  .catch((err) => {
    console.error("[server] Mongo connection error:", err);
    process.exit(1);
  });

// Garder le processus actif
process.on("SIGINT", () => {
  console.log("\n[server] Shutting down gracefully...");
  process.exit(0);
});

process.on("uncaughtException", (err) => {
  console.error("[server] Uncaught Exception:", err);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("[server] Unhandled Rejection at:", promise, "reason:", reason);
});
