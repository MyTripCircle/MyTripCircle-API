const jwt = require("jsonwebtoken");
const { ObjectId } = require("mongodb");
const { JWT_SECRET } = require("../../config");
const {
  trimIfString,
  isStrongPassword,
  sanitizeUser,
  signAccessToken,
  hashToken,
  generateOtp,
} = require("../authHelpers");

describe("trimIfString", () => {
  it("should trim strings", () => {
    expect(trimIfString("  hello  ")).toBe("hello");
  });

  it("should leave non-strings untouched", () => {
    expect(trimIfString(42)).toBe(42);
    expect(trimIfString(null)).toBeNull();
  });
});

describe("isStrongPassword", () => {
  it("should accept a password with lowercase, uppercase, digit and symbol (>= 8 chars)", () => {
    expect(isStrongPassword("Abcd1234!")).toBe(true);
  });

  it("should reject weak passwords", () => {
    expect(isStrongPassword("abcdefgh")).toBe(false); // pas de maj/chiffre/symbole
    expect(isStrongPassword("ABCD1234")).toBe(false); // pas de minuscule/symbole
    expect(isStrongPassword("Abc1!")).toBe(false); // trop court
  });

  it("should reject non-string values", () => {
    expect(isStrongPassword(undefined)).toBe(false);
    expect(isStrongPassword(12345678)).toBe(false);
  });
});

describe("signAccessToken", () => {
  it("should produce a JWT verifiable with JWT_SECRET carrying the user id", () => {
    const token = signAccessToken("user-123");
    const decoded = jwt.verify(token, JWT_SECRET);
    expect(decoded.id).toBe("user-123");
  });

  it("should coerce the user id to a string", () => {
    const token = signAccessToken(42);
    expect(jwt.verify(token, JWT_SECRET).id).toBe("42");
  });
});

describe("hashToken", () => {
  it("should be deterministic", () => {
    expect(hashToken("a-refresh-token")).toBe(hashToken("a-refresh-token"));
  });

  it("should return a 64-char hex digest", () => {
    expect(hashToken("x")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("should distinguish different inputs", () => {
    expect(hashToken("abc")).not.toBe(hashToken("abd"));
  });
});

describe("generateOtp", () => {
  it("should return a 6-digit string", () => {
    for (let i = 0; i < 50; i++) {
      expect(generateOtp()).toMatch(/^\d{6}$/);
    }
  });
});

describe("sanitizeUser", () => {
  it("should return null for a falsy document", () => {
    expect(sanitizeUser(null)).toBeNull();
  });

  it("should expose only the public fields with sensible defaults", () => {
    const id = new ObjectId();
    const result = sanitizeUser({
      _id: id,
      name: "Alice",
      email: "alice@test.com",
      phone: null,
      avatar: "avatar-url",
      password: "should-not-leak",
    });
    expect(result).toEqual({
      id: String(id),
      name: "Alice",
      email: "alice@test.com",
      phone: null,
      avatar: "avatar-url",
      verified: false,
      createdAt: undefined,
      language: "fr",
      isPublicProfile: false,
    });
    expect(result).not.toHaveProperty("password");
  });

  it("should keep provided verified / language / isPublicProfile values", () => {
    const result = sanitizeUser({
      _id: new ObjectId(),
      name: "Bob",
      verified: true,
      language: "en",
      isPublicProfile: true,
    });
    expect(result).toMatchObject({ verified: true, language: "en", isPublicProfile: true });
  });
});
