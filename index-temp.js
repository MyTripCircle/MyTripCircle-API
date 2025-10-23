// Backend temporaire sans MongoDB pour tester la connexion
const express = require("express");
const cors = require("cors");
const os = require("os");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.API_PORT ? parseInt(process.env.API_PORT, 10) : 4000;

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

// Données temporaires pour les tests
const mockData = {
  trips: [
    {
      _id: "1",
      title: "Voyage à Paris",
      description: "Weekend à Paris",
      destination: "Paris, France",
      startDate: "2024-01-15",
      endDate: "2024-01-17",
      collaborators: ["user1", "user2"],
      ownerId: "user1",
      isPublic: true,
      createdAt: "2024-01-10T10:00:00Z",
      updatedAt: "2024-01-10T10:00:00Z",
    },
    {
      _id: "2",
      title: "Vacances en Espagne",
      description: "Séjour à Barcelone",
      destination: "Barcelone, Espagne",
      startDate: "2024-02-10",
      endDate: "2024-02-17",
      collaborators: ["user1"],
      ownerId: "user1",
      isPublic: true,
      createdAt: "2024-01-20T14:30:00Z",
      updatedAt: "2024-01-20T14:30:00Z",
    },
  ],
  bookings: [
    {
      _id: "1",
      tripId: "1",
      type: "hotel",
      title: "Hôtel Plaza",
      description: "Hôtel 4 étoiles en centre-ville",
      date: "2024-01-15",
      time: "15:00",
      address: "123 Rue de la Paix, Paris",
      confirmationNumber: "HP123456",
      price: 150,
      currency: "€",
      status: "confirmed",
      createdAt: "2024-01-12T09:00:00Z",
      updatedAt: "2024-01-12T09:00:00Z",
    },
    {
      _id: "2",
      tripId: "1",
      type: "flight",
      title: "Vol Paris-Barcelone",
      description: "Vol aller-retour avec Air France",
      date: "2024-01-15",
      time: "08:30",
      confirmationNumber: "AF789012",
      price: 250,
      currency: "€",
      status: "confirmed",
      createdAt: "2024-01-10T14:00:00Z",
      updatedAt: "2024-01-10T14:00:00Z",
    },
    {
      _id: "3",
      tripId: "2",
      type: "restaurant",
      title: "Restaurant El Nacional",
      description: "Dîner gastronomique",
      date: "2024-02-12",
      time: "20:00",
      address: "Passeig de Gràcia, 24, Barcelona",
      price: 80,
      currency: "€",
      status: "pending",
      createdAt: "2024-01-25T16:30:00Z",
      updatedAt: "2024-01-25T16:30:00Z",
    },
  ],
  addresses: [
    {
      _id: "1",
      tripId: "1",
      name: "Tour Eiffel",
      address: "Champ de Mars, 7e arrondissement, Paris",
      coordinates: { lat: 48.8584, lng: 2.2945 },
      createdAt: "2024-01-11T16:00:00Z",
      updatedAt: "2024-01-11T16:00:00Z",
    },
  ],
};

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    message: "Backend temporaire fonctionne!",
    timestamp: new Date().toISOString(),
  });
});

app.get("/test", (req, res) => {
  res.status(200).json({
    message: "Backend temporaire is working!",
    timestamp: new Date().toISOString(),
    trips: "Use /trips endpoint",
    bookings: "Use /bookings endpoint",
    addresses: "Use /addresses endpoint",
    note: "Ceci est un backend temporaire sans MongoDB",
  });
});

app.get("/trips", async (_req, res) => {
  try {
    res.json(mockData.trips);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/trips/:id", async (req, res) => {
  try {
    const item = mockData.trips.find((trip) => trip._id === req.params.id);
    if (!item) return res.status(404).json({ error: "Not found" });
    res.json(item);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/bookings", async (_req, res) => {
  try {
    res.json(mockData.bookings);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/bookings/trip/:tripId", async (req, res) => {
  try {
    const items = mockData.bookings.filter(
      (booking) => booking.tripId === req.params.tripId
    );
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/addresses", async (_req, res) => {
  try {
    res.json(mockData.addresses);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/addresses/trip/:tripId", async (req, res) => {
  try {
    const items = mockData.addresses.filter(
      (addr) => addr.tripId === req.params.tripId
    );
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const server = app.listen(PORT, ACTIVE_IP, () => {
  console.log(
    `[server] Backend temporaire démarré sur http://${ACTIVE_IP}:${PORT}`
  );
  console.log(`[server] Accessible via http://localhost:${PORT}`);
  console.log(`[server] Utilisez cette IP dans votre app: ${ACTIVE_IP}`);
  console.log(
    `[server] Note: Ceci est un backend temporaire avec des données mockées`
  );
  console.log(
    `[server] Serveur en cours d'exécution... Appuyez sur Ctrl+C pour arrêter`
  );
});

// Garder le serveur actif
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

// Garder le processus actif
process.on("SIGINT", () => {
  console.log("\n[server] Arrêt du serveur...");
  server.close(() => {
    console.log("[server] Serveur fermé proprement");
    process.exit(0);
  });
});

process.on("uncaughtException", (err) => {
  console.error("[server] Exception non gérée:", err);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("[server] Rejet non géré:", promise, "raison:", reason);
});

// Empêcher le processus de se terminer
setInterval(() => {
  // Heartbeat pour maintenir le processus actif
}, 1000);
