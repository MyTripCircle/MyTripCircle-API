require("dotenv").config();
const os = require("node:os");

const { validateEnv, PORT } = require("./config");
const { connectMongo } = require("./db");
const logger = require("./utils/logger");
const { startCleanupJob } = require("./utils/cleanupJob");
const app = require("./app");

// Validation des variables d'environnement au démarrage
validateEnv();

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
      logger.info(`[server] API démarrée sur http://${ACTIVE_IP}:${PORT}`);
      logger.info(`[server] Également accessible via http://localhost:${PORT}`);
      startCleanupJob();
    });
  })
  .catch((err) => {
    logger.error("[server] Erreur de connexion MongoDB :", err);
    process.exit(1);
  });

process.on("SIGINT", () => {
  logger.info("\n[server] Arrêt propre...");
  process.exit(0);
});

process.on("uncaughtException", (err) => {
  logger.error("[server] Exception non capturée :", err);
});

process.on("unhandledRejection", (reason) => {
  logger.error("[server] Rejet de promesse non géré :", reason);
});
