const { isValidEmail, isValidPhone } = require("../validators");

describe("isValidEmail", () => {
  it("should accept a well-formed email", () => {
    expect(isValidEmail("user@example.com")).toBe(true);
    expect(isValidEmail("first.last+tag@sub.domain.fr")).toBe(true);
  });

  it("should reject malformed emails", () => {
    expect(isValidEmail("user@")).toBe(false);
    expect(isValidEmail("@example.com")).toBe(false);
    expect(isValidEmail("userexample.com")).toBe(false);
    expect(isValidEmail("user@example")).toBe(false);
  });

  it("should reject non-string values", () => {
    expect(isValidEmail(undefined)).toBe(false);
    expect(isValidEmail(null)).toBe(false);
    expect(isValidEmail(42)).toBe(false);
  });
});

describe("isValidPhone", () => {
  it("should accept common phone formats", () => {
    expect(isValidPhone("+33612345678")).toBe(true);
    expect(isValidPhone("06 12 34 56 78")).toBe(true);
    expect(isValidPhone("(555) 123-4567")).toBe(true);
  });

  it("should reject too short or too long inputs", () => {
    expect(isValidPhone("12345")).toBe(false);
    expect(isValidPhone("1".repeat(25))).toBe(false);
  });

  it("should reject non-string values", () => {
    expect(isValidPhone(undefined)).toBe(false);
    expect(isValidPhone(33612345678)).toBe(false);
  });
});
