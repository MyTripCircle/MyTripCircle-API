const express = require("express");

/**
 * Monte un routeur Express isolé pour les tests supertest.
 * Le bootstrap serveur (connexion Mongo, helmet, CORS…) n'est volontairement pas
 * chargé : seul le routeur sous test l'est.
 */
function createApp(mountPath, router) {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use(mountPath, router);
  return app;
}

/**
 * Neutralise les sorties console du logger applicatif pendant les tests de
 * chemins d'erreur. Retourne une fonction de restauration.
 */
function silenceConsole() {
  const spies = [
    jest.spyOn(console, "error").mockImplementation(() => {}),
    jest.spyOn(console, "warn").mockImplementation(() => {}),
    jest.spyOn(console, "log").mockImplementation(() => {}),
  ];
  return () => spies.forEach((spy) => spy.mockRestore());
}

module.exports = { createApp, silenceConsole };
