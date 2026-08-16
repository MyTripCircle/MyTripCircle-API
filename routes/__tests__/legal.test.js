const request = require("supertest");
const { createApp } = require("../../__tests__/helpers/routerApp");
const legalRouter = require("../legal");

describe("legal router", () => {
  let app;

  beforeAll(() => {
    app = createApp("/legal", legalRouter);
  });

  describe("GET /legal/privacy", () => {
    it("should serve the privacy policy as UTF-8 HTML", async () => {
      // Act
      const res = await request(app).get("/legal/privacy");

      // Assert
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
    });

    it("should mention the data protection contact address", async () => {
      // Act
      const res = await request(app).get("/legal/privacy");

      // Assert
      expect(res.text).toContain("privacy@mytripcircle.com");
    });
  });

  describe("GET /legal/terms", () => {
    it("should serve the terms of use as UTF-8 HTML", async () => {
      // Act
      const res = await request(app).get("/legal/terms");

      // Assert
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
    });

    it("should mention the support contact address", async () => {
      // Act
      const res = await request(app).get("/legal/terms");

      // Assert
      expect(res.text).toContain("support@mytripcircle.com");
    });
  });
});
