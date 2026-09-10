const {
  effectiveVisibility,
  isTripPublic,
  requestedVisibility,
  isValidVisibility,
} = require("../tripVisibility");

describe("tripVisibility", () => {
  describe("effectiveVisibility", () => {
    it("should return the stored visibility when it is set", () => {
      expect(effectiveVisibility({ visibility: "friends", isPublic: true })).toBe("friends");
    });

    it("should fall back on the legacy isPublic flag when visibility is absent", () => {
      expect(effectiveVisibility({ isPublic: true })).toBe("public");
    });

    it("should default to private when neither field is set", () => {
      expect(effectiveVisibility({})).toBe("private");
    });
  });

  describe("isTripPublic", () => {
    it("should be true when visibility is public", () => {
      expect(isTripPublic({ visibility: "public" })).toBe(true);
    });

    it("should be false when visibility is private even though isPublic is true", () => {
      expect(isTripPublic({ visibility: "private", isPublic: true })).toBe(false);
    });

    it("should be true for a legacy document that only carries isPublic", () => {
      expect(isTripPublic({ isPublic: true })).toBe(true);
    });
  });

  describe("requestedVisibility", () => {
    it("should prefer visibility over isPublic when both are sent", () => {
      expect(requestedVisibility({ visibility: "friends", isPublic: true })).toBe("friends");
    });

    it("should derive the visibility from isPublic when only the flag is sent", () => {
      expect(requestedVisibility({ isPublic: false })).toBe("private");
    });

    it("should return undefined when the request carries neither field", () => {
      expect(requestedVisibility({})).toBeUndefined();
    });
  });

  describe("isValidVisibility", () => {
    it.each(["private", "friends", "public"])("should accept %s", (value) => {
      expect(isValidVisibility(value)).toBe(true);
    });

    it("should reject a value outside the enumeration", () => {
      expect(isValidVisibility("everyone")).toBe(false);
    });
  });
});
