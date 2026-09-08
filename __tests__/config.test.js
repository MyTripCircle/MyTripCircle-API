// `server/config.js` lit `process.env` au chargement et coupe le processus sur
// configuration invalide. Chaque test recharge donc le module dans un
// environnement maîtrisé, avec `process.exit` remplacé par une exception
// sentinelle pour interrompre l'exécution comme le ferait l'arrêt réel.

const VALID_ENV = {
  NODE_ENV: "test",
  MONGODB_URI: "mongodb://localhost:27017/mytripcircle-test",
  JWT_SECRET: "test-jwt-secret",
  REFRESH_SECRET: "test-refresh-secret",
  ENCRYPTION_KEY:
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  HMAC_KEY:
    "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
};

const EXIT_SENTINEL = "process.exit(1)";

describe("server config", () => {
  let originalEnv;
  let exitSpy;
  let errorSpy;
  let warnSpy;

  beforeEach(() => {
    originalEnv = process.env;
    process.env = { ...VALID_ENV };
    jest.resetModules();
    exitSpy = jest.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`${EXIT_SENTINEL}:${code}`);
    });
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  describe("validateEnv", () => {
    it("should abort and list the variables when required ones are missing", () => {
      // Arrange
      delete process.env.MONGODB_URI;
      delete process.env.REFRESH_SECRET;
      const { validateEnv } = require("../config");

      // Act & Assert
      expect(() => validateEnv()).toThrow(`${EXIT_SENTINEL}:1`);
      expect(errorSpy).toHaveBeenCalledWith(
        "[config] Variables d'environnement manquantes : MONGODB_URI, REFRESH_SECRET"
      );
    });

    it.each([
      ["trop courte", "0123456789abcdef"],
      ["non hexadécimale", "z".repeat(64)],
    ])("should abort when ENCRYPTION_KEY is %s", (_label, key) => {
      // Arrange
      process.env.ENCRYPTION_KEY = key;
      const { validateEnv } = require("../config");

      // Act & Assert
      expect(() => validateEnv()).toThrow(`${EXIT_SENTINEL}:1`);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("[config] ENCRYPTION_KEY doit être une chaîne hexadécimale")
      );
    });

    it("should abort when HMAC_KEY is shorter than 64 hexadecimal characters", () => {
      // Arrange
      process.env.HMAC_KEY = "abcdef";
      const { validateEnv } = require("../config");

      // Act & Assert
      expect(() => validateEnv()).toThrow(`${EXIT_SENTINEL}:1`);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("[config] HMAC_KEY doit être une chaîne hexadécimale")
      );
    });

    it("should accept an HMAC_KEY longer than 64 hexadecimal characters", () => {
      // Arrange
      process.env.HMAC_KEY = "ab".repeat(64);
      const { validateEnv } = require("../config");

      // Act
      validateEnv();

      // Assert
      expect(exitSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it("should throw when the default JWT_SECRET is used in production", () => {
      // Arrange
      process.env.NODE_ENV = "production";
      process.env.JWT_SECRET = "dev-secret-change-me";
      const { validateEnv } = require("../config");

      // Act & Assert
      expect(() => validateEnv()).toThrow(
        "[config] JWT_SECRET utilise la valeur par défaut. Changez-la avant de démarrer en production."
      );
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it("should only warn when the default JWT_SECRET is used outside production", () => {
      // Arrange
      process.env.JWT_SECRET = "dev-secret-change-me";
      const { validateEnv } = require("../config");

      // Act
      validateEnv();

      // Assert
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[config] AVERTISSEMENT : JWT_SECRET est encore la valeur par défaut")
      );
      expect(exitSpy).not.toHaveBeenCalled();
    });

    // Sans allowlist, CORS avec identifiants refuse le joker : l'API démarrerait
    // en étant inaccessible au navigateur. L'échec au démarrage est préféré.
    it("should refuse to start in production when no allowed origin is declared", () => {
      // Arrange
      process.env.NODE_ENV = "production";
      delete process.env.ALLOWED_ORIGINS;
      const { validateEnv } = require("../config");

      // Act & Assert
      expect(() => validateEnv()).toThrow(`${EXIT_SENTINEL}:1`);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("[config] ALLOWED_ORIGINS est vide")
      );
    });

    it("should warn about env-based secrets when running in production", () => {
      // Arrange
      process.env.NODE_ENV = "production";
      process.env.ALLOWED_ORIGINS = "https://app.exemple.test";
      const { validateEnv } = require("../config");

      // Act
      validateEnv();

      // Assert — RGPD : rappel d'utiliser un gestionnaire de secrets dédié
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[config] AVERTISSEMENT RGPD")
      );
    });

    it("should stay silent in production when a secrets provider is configured", () => {
      // Arrange
      process.env.NODE_ENV = "production";
      process.env.ALLOWED_ORIGINS = "https://app.exemple.test";
      process.env.SECRETS_PROVIDER = "vault";
      const { validateEnv } = require("../config");

      // Act
      validateEnv();

      // Assert
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("should pass silently when the environment is fully valid", () => {
      // Arrange
      const { validateEnv } = require("../config");

      // Act
      validateEnv();

      // Assert
      expect(exitSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe("exported values", () => {
    it("should read the API port from the environment when it is set", () => {
      // Arrange
      process.env.API_PORT = "8080";

      // Act
      const config = require("../config");

      // Assert
      expect(config.PORT).toBe(8080);
    });

    it("should fall back to port 4000 when API_PORT is not set", () => {
      // Act
      const config = require("../config");

      // Assert
      expect(config.PORT).toBe(4000);
    });

    it("should expose the environment overrides when they are provided", () => {
      // Arrange
      process.env.DB_NAME = "mytripcircle-staging";
      process.env.API_BASE_URL = "https://staging.mytripcircle.test";
      process.env.GOOGLE_PLACES_API_KEY = "places-key";
      process.env.APPLE_APP_ID = "com.mytripcircle.app";
      process.env.APPLE_SHARED_SECRET = "apple-secret";
      process.env.MAIL_USER = "bot@mytripcircle.test";
      process.env.MAIL_PASS = "mot-de-passe";
      process.env.GROQ_API_KEY = "groq-key";
      process.env.IAP_SKIP_VALIDATION = "true";

      // Act
      const config = require("../config");

      // Assert
      expect(config).toMatchObject({
        DB_NAME: "mytripcircle-staging",
        API_BASE_URL: "https://staging.mytripcircle.test",
        GOOGLE_PLACES_API_KEY: "places-key",
        APPLE_APP_ID: "com.mytripcircle.app",
        APPLE_SHARED_SECRET: "apple-secret",
        MAIL_USER: "bot@mytripcircle.test",
        MAIL_PASS: "mot-de-passe",
        GROQ_API_KEY: "groq-key",
        IAP_SKIP_VALIDATION: true,
        MONGODB_URI: VALID_ENV.MONGODB_URI,
        JWT_SECRET: VALID_ENV.JWT_SECRET,
        REFRESH_SECRET: VALID_ENV.REFRESH_SECRET,
      });
    });

    it("should apply the documented defaults when the optional variables are absent", () => {
      // Act
      const config = require("../config");

      // Assert
      expect(config).toMatchObject({
        DB_NAME: "mytripcircle",
        API_BASE_URL: "https://mytripcircle-api.enzo-turpin.fr",
        GOOGLE_PLACES_API_KEY: "",
        APPLE_APP_ID: null,
        APPLE_SHARED_SECRET: null,
        IAP_SKIP_VALIDATION: false,
      });
    });

    it("should treat any IAP_SKIP_VALIDATION value other than \"true\" as disabled", () => {
      // Arrange
      process.env.IAP_SKIP_VALIDATION = "1";

      // Act
      const config = require("../config");

      // Assert — seule la chaîne exacte "true" désactive la validation Apple
      expect(config.IAP_SKIP_VALIDATION).toBe(false);
    });
  });
});
