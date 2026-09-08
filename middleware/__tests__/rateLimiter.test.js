// `express-rate-limit` est remplacé par un double qui conserve les options
// reçues : un limiteur est entièrement décrit par sa configuration (fenêtre,
// quota, fonction de clé), c'est donc elle que l'on vérifie ici.
// Préfixe `mock` obligatoire : la factory de jest.mock est hoistée au-dessus des require.
const mockRateLimit = jest.fn((options) => {
  const middleware = (_req, _res, next) => next();
  middleware.options = options;
  return middleware;
});

jest.mock("express-rate-limit", () => mockRateLimit);

const {
  authLimiter,
  generalLimiter,
  searchLimiter,
  iapLimiter,
} = require("../rateLimiter");

describe("rateLimiter", () => {
  describe("authLimiter", () => {
    it("should allow only 5 attempts per 15 minutes when protecting authentication", () => {
      // Act
      const { windowMs, max } = authLimiter.options;

      // Assert
      expect(windowMs).toBe(15 * 60 * 1000);
      expect(max).toBe(5);
    });

    it("should count only failed attempts when a request succeeds", () => {
      // Assert — anti brute force : une connexion réussie ne consomme pas le quota
      expect(authLimiter.options.skipSuccessfulRequests).toBe(true);
    });

    it("should limit per IP when no key generator is provided", () => {
      // Assert — l'utilisateur n'est pas encore authentifié sur ces routes
      expect(authLimiter.options.keyGenerator).toBeUndefined();
    });
  });

  describe.each([
    ["generalLimiter", generalLimiter, 60 * 1000, 1000],
    ["searchLimiter", searchLimiter, 60 * 1000, 10],
    ["iapLimiter", iapLimiter, 60 * 60 * 1000, 10],
  ])("%s", (_name, limiter, expectedWindowMs, expectedMax) => {
    it("should apply the documented window and quota", () => {
      // Act
      const { windowMs, max } = limiter.options;

      // Assert
      expect(windowMs).toBe(expectedWindowMs);
      expect(max).toBe(expectedMax);
    });

    it("should count per user id when the request is authenticated", () => {
      // Arrange
      const req = { user: { _id: 42 }, ip: "10.0.0.1" };

      // Act
      const key = limiter.options.keyGenerator(req);

      // Assert — l'identifiant utilisateur prime sur l'IP et il est normalisé en chaîne
      expect(key).toBe("42");
    });

    it("should fall back to the client IP when the request is anonymous", () => {
      // Arrange
      const req = { ip: "10.0.0.1" };

      // Act
      const key = limiter.options.keyGenerator(req);

      // Assert
      expect(key).toBe("10.0.0.1");
    });

    it("should fall back to a shared bucket when neither user id nor IP is known", () => {
      // Arrange — utilisateur sans _id et requête dont l'IP n'a pas pu être résolue
      const req = { user: {} };

      // Act
      const key = limiter.options.keyGenerator(req);

      // Assert
      expect(key).toBe("unknown");
    });

    it("should disable the built-in IP fallback validation", () => {
      // Assert — le keyGenerator personnalisé gère lui-même l'absence d'IP
      expect(limiter.options.validate).toEqual({ keyGeneratorIpFallback: false });
    });
  });

  it("should answer with a structured error payload for every limiter", () => {
    // Act
    const messages = [authLimiter, generalLimiter, searchLimiter, iapLimiter].map(
      (limiter) => limiter.options.message
    );

    // Assert — le client attend toujours la forme { success, error }
    messages.forEach((message) => {
      expect(message.success).toBe(false);
      expect(typeof message.error).toBe("string");
    });
  });
});
