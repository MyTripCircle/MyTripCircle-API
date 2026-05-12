const request = require("supertest");
const express = require("express");
const { errorHandler, notFound } = require("../errorHandler");

function buildApp() {
  const app = express();
  app.get("/boom", (_req, _res, next) => next(new Error("kaboom interne")));
  app.get("/teapot", (_req, _res, next) => {
    const err = new Error("Je suis une théière");
    err.status = 418;
    next(err);
  });
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

describe("error handling middleware", () => {
  let app;
  let errorSpy;

  beforeAll(() => {
    app = buildApp();
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterAll(() => errorSpy.mockRestore());

  it("notFound — should return 404 with a generic message", async () => {
    const res = await request(app).get("/route-inexistante");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: "Route introuvable" });
  });

  it("errorHandler — should mask 500 errors behind a generic message", async () => {
    const res = await request(app).get("/boom");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ success: false, error: "Erreur interne du serveur" });
  });

  it("errorHandler — should pass the message through for non-500 statuses", async () => {
    const res = await request(app).get("/teapot");
    expect(res.status).toBe(418);
    expect(res.body).toEqual({ success: false, error: "Je suis une théière" });
  });
});
