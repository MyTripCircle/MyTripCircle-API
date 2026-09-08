// Deux projets : l'API elle-même et les scripts d'exploitation de la base, qui
// s'exécutent hors du serveur mais partagent son accès aux données.
module.exports = {
  projects: [
    {
      displayName: "api",
      testEnvironment: "node",
      testMatch: ["<rootDir>/**/*.test.js"],
      testPathIgnorePatterns: ["<rootDir>/node_modules/", "<rootDir>/scripts/"],
      setupFiles: ["<rootDir>/__tests__/setupEnv.js"],
      // Le premier démarrage télécharge le binaire MongoDB utilisé par la base
      // en mémoire : le délai par défaut de 5 s expire avant la fin, et seul le
      // premier cas de chaque suite en pâtit — un échec qui ne dit rien du code.
      testTimeout: 30000,
    },
    {
      displayName: "scripts",
      testEnvironment: "node",
      testMatch: ["<rootDir>/scripts/**/*.test.js"],
    },
  ],
  // Périmètre de couverture : tout le code exécutable, moins les omissions
  // justifiées ci-dessous. Un fichier absent de la mesure est un fichier dont
  // personne ne sait s'il est testé.
  collectCoverageFrom: [
    "**/*.js",

    "!**/node_modules/**",
    "!**/__tests__/**",
    "!jest.config.js",

    // Le rapport HTML produit par Jest lui-même : des scripts de présentation,
    // pas du code applicatif.
    "!coverage/**",

    // Points d'entrée : validés par les tests d'intégration, qui démarrent
    // l'application plutôt que d'en tester les unités.
    "!index.js",
    "!db.js",
  ],
};
