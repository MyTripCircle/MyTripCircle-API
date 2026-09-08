const request = require("supertest");
const express = require("express");
const cookieParser = require("cookie-parser");

// L'allowlist est figée au require de config : elle doit être posée avant.
const ALLOWED_ORIGIN = "https://app.test.local";
process.env.ALLOWED_ORIGINS = ALLOWED_ORIGIN;

const { csrfProtection } = require("../csrf");
const { ACCESS_COOKIE, CSRF_COOKIE } = require("../../utils/authCookies");

const CSRF_TOKEN = "jeton-csrf-de-test";
const SESSION_COOKIES = [`${ACCESS_COOKIE}=jwt-factice`, `${CSRF_COOKIE}=${CSRF_TOKEN}`];

function buildApp() {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(csrfProtection);
  app.post("/mutate", (_req, res) => res.json({ ok: true }));
  app.get("/read", (_req, res) => res.json({ ok: true }));
  return app;
}

describe("csrfProtection middleware", () => {
  let app;
  let warnSpy;

  beforeAll(() => {
    app = buildApp();
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterAll(() => warnSpy.mockRestore());

  it("should let a safe method through when no CSRF token is provided", async () => {
    const res = await request(app).get("/read");
    expect(res.status).toBe(200);
  });

  it("should let a mutating request through when no auth cookie is present", async () => {
    const res = await request(app).post("/mutate").send({});
    expect(res.status).toBe(200);
  });

  it("should let a mutating request through when it authenticates with a Bearer header", async () => {
    // Arrange / Act : cookie présent mais en-tête explicite — non forgeable cross-site
    const res = await request(app)
      .post("/mutate")
      .set("Cookie", SESSION_COOKIES)
      .set("Authorization", "Bearer un-token")
      .send({});

    // Assert
    expect(res.status).toBe(200);
  });

  it("should reject a cookie-authenticated request when Sec-Fetch-Site is cross-site", async () => {
    // Act
    const res = await request(app)
      .post("/mutate")
      .set("Cookie", SESSION_COOKIES)
      .set("Origin", ALLOWED_ORIGIN)
      .set("Sec-Fetch-Site", "cross-site")
      .set("X-CSRF-Token", CSRF_TOKEN)
      .send({});

    // Assert
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Requête cross-site refusée");
  });

  it("should reject a cookie-authenticated request when the Origin is not allowlisted", async () => {
    // Act
    const res = await request(app)
      .post("/mutate")
      .set("Cookie", SESSION_COOKIES)
      .set("Origin", "https://evil.test.local")
      .set("X-CSRF-Token", CSRF_TOKEN)
      .send({});

    // Assert
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Origine non autorisée");
  });

  it("should reject a cookie-authenticated request when no provenance header is present", async () => {
    // Act
    const res = await request(app)
      .post("/mutate")
      .set("Cookie", SESSION_COOKIES)
      .set("X-CSRF-Token", CSRF_TOKEN)
      .send({});

    // Assert
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Origine manquante");
  });

  it("should reject a cookie-authenticated request when the CSRF header is missing", async () => {
    // Act
    const res = await request(app)
      .post("/mutate")
      .set("Cookie", SESSION_COOKIES)
      .set("Origin", ALLOWED_ORIGIN)
      .send({});

    // Assert
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Jeton CSRF invalide");
  });

  it("should reject a cookie-authenticated request when the CSRF header does not match the cookie", async () => {
    // Act
    const res = await request(app)
      .post("/mutate")
      .set("Cookie", SESSION_COOKIES)
      .set("Origin", ALLOWED_ORIGIN)
      .set("X-CSRF-Token", "un-autre-jeton")
      .send({});

    // Assert
    expect(res.status).toBe(403);
  });

  it("should accept a cookie-authenticated request when origin and CSRF token both match", async () => {
    // Act
    const res = await request(app)
      .post("/mutate")
      .set("Cookie", SESSION_COOKIES)
      .set("Origin", ALLOWED_ORIGIN)
      .set("Sec-Fetch-Site", "same-site")
      .set("X-CSRF-Token", CSRF_TOKEN)
      .send({});

    // Assert
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
