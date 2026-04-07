require("dotenv").config();
const os = require("os");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");

const { validateEnv, PORT } = require("./config");
const { connectMongo } = require("./db");
const { generalLimiter } = require("./middleware/rateLimiter");
const { errorHandler, notFound } = require("./middleware/errorHandler");

const { router: authRouter } = require("./routes/auth");
const usersRouter = require("./routes/users");
const tripsRouter = require("./routes/trips");
const bookingsRouter = require("./routes/bookings");
const addressesRouter = require("./routes/addresses");
const invitationsRouter = require("./routes/invitations");
const friendsRouter = require("./routes/friends");
const itineraryRouter = require("./routes/itinerary");

// Validation des variables d'environnement au démarrage
validateEnv();

const app = express();

// ─── Proxy (Traefik) ──────────────────────────────────────────────────────────
app.set("trust proxy", 1);

// ─── Sécurité ─────────────────────────────────────────────────────────────────
app.use(helmet());
app.use(helmet.hsts({ maxAge: 31536000, includeSubDomains: true, preload: true }));

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim())
  : [];

app.use(cors({
  origin: ALLOWED_ORIGINS,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

app.use(express.json({ limit: "5mb" }));
app.use(generalLimiter);

// ─── Logging minimal ──────────────────────────────────────────────────────────
app.use((req, _res, next) => {
  console.log(`[server] ${req.method} ${req.path}`);
  next();
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ ok: true }));

app.use("/users", authRouter);
app.use("/users", usersRouter);
app.use("/trips", tripsRouter);
app.use("/bookings", bookingsRouter);
app.use("/addresses", addressesRouter);
app.use("/invitations", invitationsRouter);
app.use("/friends", friendsRouter);
app.use("/itinerary", itineraryRouter);

// Deep link redirect (reset mot de passe)
app.get("/reset-password", (req, res) => {
  res.redirect(`/users/reset-password-page?token=${req.query.token || ""}`);
});

// Deep link redirect (invitation voyage)
app.get("/join/:token", (req, res) => {
  res.redirect(`/invitations/join/${req.params.token}`);
});

// ─── Erreurs ──────────────────────────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

// ─── Démarrage ────────────────────────────────────────────────────────────────
const ACTIVE_IP =
  process.env.API_IP_PRIMARY ||
  (() => {
    const interfaces = os.networkInterfaces();
    for (const name of ["Wi-Fi", "Ethernet", "en0", "eth0"]) {
      for (const iface of interfaces[name] || []) {
        if (iface.family === "IPv4" && !iface.internal) return iface.address;
      }
    }
    for (const ifaces of Object.values(os.networkInterfaces())) {
      for (const iface of ifaces) {
        if (iface.family === "IPv4" && !iface.internal) return iface.address;
      }
    }
    return "localhost";
  })();

connectMongo()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`[server] API démarrée sur http://${ACTIVE_IP}:${PORT}`);
      console.log(`[server] Également accessible via http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("[server] Erreur de connexion MongoDB :", err);
    process.exit(1);
  });

process.on("SIGINT", () => {
  console.log("\n[server] Arrêt propre...");
  process.exit(0);
});

process.on("uncaughtException", (err) => {
  console.error("[server] Exception non capturée :", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("[server] Rejet de promesse non géré :", reason);
});
