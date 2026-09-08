const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");

const logger = require("./utils/logger");
const { ALLOWED_ORIGINS, IS_PRODUCTION } = require("./config");
const { generalLimiter } = require("./middleware/rateLimiter");
const { errorHandler, notFound } = require("./middleware/errorHandler");
const { auditLog } = require("./middleware/auditLog");
const { csrfProtection } = require("./middleware/csrf");
const { CSRF_HEADER } = require("./utils/authCookies");

const { router: authRouter } = require("./routes/auth");
const oauthRouter = require("./routes/oauth");
const otpRouter = require("./routes/otp");
const usersRouter = require("./routes/users");
const pushRouter = require("./routes/push");
const tripsRouter = require("./routes/trips");
const bookingsRouter = require("./routes/bookings");
const addressesRouter = require("./routes/addresses");
const invitationsRouter = require("./routes/invitations");
const friendsRouter = require("./routes/friends");
const friendRequestsRouter = require("./routes/friendRequests");
const friendInvitesRouter = require("./routes/friendInvites");
const itineraryRouter = require("./routes/itinerary");
const placesRouter = require("./routes/places");
const legalRouter = require("./routes/legal");
const moderationRouter = require("./routes/moderation");
const subscriptionsRouter = require("./routes/subscriptions");
const calendarRouter = require("./routes/calendar");

// Construit l'application Express sans la démarrer ni se connecter à Mongo.
// Le bootstrap (validateEnv, connectMongo, listen) reste dans index.js — cette
// séparation permet de tester l'app avec supertest sans ouvrir de port ni de
// connexion réseau (l'appelant injecte la base, ex. mongodb-memory-server).
const app = express();

// ─── Proxy (Traefik) ──────────────────────────────────────────────────────────
app.set("trust proxy", 1);

// ─── Sécurité ─────────────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'none'"],
      styleSrc: ["'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      formAction: ["'none'"],
    },
  },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
}));

if (ALLOWED_ORIGINS.length === 0 && IS_PRODUCTION) {
  logger.warn("[cors] ALLOWED_ORIGINS non configuré — toutes les requêtes CORS navigateur seront bloquées");
}

// `credentials: true` autorise l'envoi des cookies httpOnly depuis le front web.
// Combiné à une origine wildcard, il est rejeté par les navigateurs : l'allowlist
// reste donc stricte (vide = tout bloqué, cf. validateEnv en production).
// `Cookie` n'est pas listé dans allowedHeaders : c'est un en-tête interdit au JS,
// posé par le navigateur lui-même, il n'apparaît jamais dans le preflight.
app.use(cors({
  origin: ALLOWED_ORIGINS,
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", CSRF_HEADER],
}));

app.use(cookieParser());

// Stripe signe le corps brut : tout parsing JSON préalable invaliderait la
// signature. Ce parseur dédié doit rester monté AVANT express.json().
app.use("/subscriptions/webhook", express.raw({ type: "application/json" }));

app.use(express.json({ limit: "5mb" }));
app.use(csrfProtection);
app.use(generalLimiter);

// ─── Logging minimal ──────────────────────────────────────────────────────────
app.use((req, _res, next) => {
  logger.debug(`[server] ${req.method} ${req.path}`);
  next();
});

// ─── Audit log accès données personnelles ─────────────────────────────────────
app.use(auditLog);

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ ok: true }));

// Android App Links — requis pour la vérification autoVerify (SEC-024)
// Le SHA256 fingerprint doit correspondre au certificat de signature de l'APK.
// Obtenir via : keytool -list -v -keystore <keystore> (ou depuis EAS Build)
app.get("/.well-known/assetlinks.json", (_req, res) => {
  res.json([{
    relation: ["delegate_permission/common.handle_all_urls"],
    target: {
      namespace: "android_app",
      package_name: "com.panda_sauvage.MyTripCircle",
      sha256_cert_fingerprints: [
        process.env.ANDROID_SHA256_FINGERPRINT || "",
      ],
    },
  }]);
});

app.use("/users", authRouter);
app.use("/users", oauthRouter);
app.use("/users", otpRouter);
app.use("/users", pushRouter);
app.use("/users", usersRouter);
app.use("/trips", tripsRouter);
app.use("/bookings", bookingsRouter);
app.use("/addresses", addressesRouter);
app.use("/invitations", invitationsRouter);
app.use("/friends", friendsRouter);
app.use("/friends", friendRequestsRouter);
app.use("/friends", friendInvitesRouter);
app.use("/itinerary", itineraryRouter);
app.use("/places", placesRouter);
app.use("/", legalRouter);
app.use("/moderation", moderationRouter);
app.use("/subscriptions", subscriptionsRouter);
app.use("/calendar", calendarRouter);

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

module.exports = app;
