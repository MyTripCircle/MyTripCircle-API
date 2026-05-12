const {
  encrypt,
  decrypt,
  hashField,
  encryptUserFields,
  decryptUserFields,
  encryptAddressFields,
  decryptAddressFields,
} = require("../crypto");

describe("encrypt / decrypt", () => {
  it("should round-trip a plaintext value", () => {
    const ciphertext = encrypt("données sensibles");
    expect(ciphertext).not.toBe("données sensibles");
    expect(ciphertext.split(":")).toHaveLength(3);
    expect(decrypt(ciphertext)).toBe("données sensibles");
  });

  it("should produce a different ciphertext each time (random IV)", () => {
    expect(encrypt("x")).not.toBe(encrypt("x"));
  });

  it("should return falsy input unchanged", () => {
    expect(encrypt("")).toBe("");
    expect(encrypt(null)).toBeNull();
    expect(decrypt("")).toBe("");
    expect(decrypt(null)).toBeNull();
  });

  it("should pass through values that are not in the ciphertext format", () => {
    expect(decrypt("valeur-en-clair")).toBe("valeur-en-clair");
    expect(decrypt("a:b")).toBe("a:b");
  });
});

describe("hashField", () => {
  it("should be deterministic and case-insensitive", () => {
    expect(hashField("User@Example.COM")).toBe(hashField("user@example.com"));
  });

  it("should return a 64-char hex digest", () => {
    expect(hashField("user@example.com")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("should distinguish different inputs", () => {
    expect(hashField("a@b.com")).not.toBe(hashField("a@c.com"));
  });

  it("should return null for falsy input", () => {
    expect(hashField(null)).toBeNull();
    expect(hashField("")).toBeNull();
  });
});

describe("encryptUserFields / decryptUserFields", () => {
  it("should encrypt name, email and phone and add their hashes", () => {
    const out = encryptUserFields({
      name: "Alice Martin",
      email: "alice@test.com",
      phone: "+33612345678",
      avatar: null,
    });
    expect(out.name).not.toBe("Alice Martin");
    expect(out.email).not.toBe("alice@test.com");
    expect(out.phone).not.toBe("+33612345678");
    expect(out.emailHash).toMatch(/^[0-9a-f]{64}$/);
    expect(out.phoneHash).toMatch(/^[0-9a-f]{64}$/);
    expect(out.avatar).toBeNull();
  });

  it("should round-trip through decryptUserFields", () => {
    const original = { name: "Bob", email: "bob@test.com", phone: "+33700000000" };
    const decrypted = decryptUserFields(encryptUserFields({ ...original }));
    expect(decrypted).toMatchObject(original);
  });

  it("should leave absent fields untouched", () => {
    const out = encryptUserFields({ name: "Solo" });
    expect(out.email).toBeUndefined();
    expect(out.emailHash).toBeUndefined();
  });

  it("should return falsy doc unchanged in decryptUserFields", () => {
    expect(decryptUserFields(null)).toBeNull();
  });
});

describe("encryptAddressFields / decryptAddressFields", () => {
  it("should encrypt only the sensitive fields", () => {
    const out = encryptAddressFields({ name: "Chez Léon", address: "12 rue X", city: "Lyon" });
    expect(out.name).not.toBe("Chez Léon");
    expect(out.address).not.toBe("12 rue X");
    expect(out.city).toBe("Lyon");
  });

  it("should round-trip through decryptAddressFields", () => {
    const original = { name: "Hotel Z", address: "1 av Y", city: "Nice" };
    const decrypted = decryptAddressFields(encryptAddressFields({ ...original }));
    expect(decrypted).toMatchObject(original);
  });

  it("should return falsy doc unchanged in decryptAddressFields", () => {
    expect(decryptAddressFields(undefined)).toBeUndefined();
  });
});
