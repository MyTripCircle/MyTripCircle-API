// Les origines autorisées sont figées au require de config : elles doivent être
// posées avant le chargement du module testé.
const WEB_APP_URL = "https://app.test.local";
process.env.WEB_APP_URL = WEB_APP_URL;
process.env.ALLOWED_ORIGINS = "https://autre.test.local";

const { resolveReturnTo, buildWebAppUrl } = require("../webRedirect");

describe("resolveReturnTo", () => {
  it("should accept a URL served by the configured web app origin", () => {
    // Act
    const result = resolveReturnTo(`${WEB_APP_URL}/trips?tab=upcoming`);

    // Assert
    expect(result).toBe(`${WEB_APP_URL}/trips?tab=upcoming`);
  });

  it("should accept a URL from an allowlisted CORS origin", () => {
    expect(resolveReturnTo("https://autre.test.local/callback")).toBe(
      "https://autre.test.local/callback"
    );
  });

  it("should accept the mobile deep link scheme", () => {
    expect(resolveReturnTo("mytripcircle://oauth-callback")).toContain("mytripcircle://");
  });

  it("should reject a URL whose origin is not allowlisted", () => {
    expect(resolveReturnTo("https://evil.test.local/steal")).toBeNull();
  });

  it("should reject a look-alike host that only shares a suffix", () => {
    expect(resolveReturnTo("https://app.test.local.evil.tld/steal")).toBeNull();
  });

  it("should reject a URL embedding credentials to hide the real host", () => {
    expect(resolveReturnTo("https://app.test.local@evil.tld/steal")).toBeNull();
  });

  it("should reject a javascript: URL", () => {
    expect(resolveReturnTo("javascript:alert(1)")).toBeNull(); // NOSONAR : entrée de test
  });

  it("should reject a protocol-relative URL", () => {
    expect(resolveReturnTo("//evil.tld/steal")).toBeNull();
  });

  it("should reject a malformed URL", () => {
    expect(resolveReturnTo("pas-une-url")).toBeNull();
  });

  it("should reject a non-string candidate", () => {
    expect(resolveReturnTo({ url: WEB_APP_URL })).toBeNull();
  });

  it("should reject an oversized URL", () => {
    expect(resolveReturnTo(`${WEB_APP_URL}/${"a".repeat(2100)}`)).toBeNull();
  });
});

describe("buildWebAppUrl", () => {
  it("should build an absolute web app URL with query params", () => {
    // Act
    const result = buildWebAppUrl("/reset-password", { code: "abc123" });

    // Assert
    expect(result).toBe(`${WEB_APP_URL}/reset-password?code=abc123`);
  });

  it("should prefix the path with a slash when it is missing", () => {
    expect(buildWebAppUrl("subscription")).toBe(`${WEB_APP_URL}/subscription`);
  });

  it("should return null when WEB_APP_URL is not configured", () => {
    // Arrange : le module lit la config au chargement, on la recharge sans URL
    jest.resetModules();
    delete process.env.WEB_APP_URL;
    const { buildWebAppUrl: buildWithoutConfig } = require("../webRedirect");

    // Act / Assert
    expect(buildWithoutConfig("/reset-password")).toBeNull();

    // Cleanup
    process.env.WEB_APP_URL = WEB_APP_URL;
  });
});
