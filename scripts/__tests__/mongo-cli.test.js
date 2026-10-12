const { missingEnvVars, explainConnectionError, redactUri, runMain } = require("../mongo-cli");

describe("missingEnvVars", () => {
  it("should list the connection string when it is absent", () => {
    expect(missingEnvVars({}, false)).toEqual(["MONGODB_URI"]);
  });

  it("should also list the encryption keys when they are required", () => {
    expect(missingEnvVars({ MONGODB_URI: "mongodb://localhost:27017" }, true)).toEqual([
      "ENCRYPTION_KEY",
      "HMAC_KEY",
    ]);
  });

  it("should list nothing when every variable is set", () => {
    const env = { MONGODB_URI: "mongodb://localhost:27017", ENCRYPTION_KEY: "a", HMAC_KEY: "b" };

    expect(missingEnvVars(env, true)).toEqual([]);
  });
});

describe("explainConnectionError", () => {
  it("should suggest starting a server when the connection is refused", () => {
    const message = explainConnectionError(new Error("connect ECONNREFUSED 127.0.0.1:27017"));

    expect(message).toContain("Aucun serveur MongoDB n'écoute");
  });

  it("should point at the credentials when authentication fails", () => {
    const message = explainConnectionError(new Error("Authentication failed."));

    expect(message).toContain("Identifiants refusés");
  });

  it("should point at name resolution when the host is unknown", () => {
    const message = explainConnectionError(new Error("getaddrinfo ENOTFOUND cluster.example.net"));

    expect(message).toContain("n'a pas pu être résolu");
  });

  it("should mention the allow list when server selection times out", () => {
    const message = explainConnectionError(new Error("Server selection timed out after 5000 ms"));

    expect(message).toContain("liste d'autorisation");
  });

  it("should keep the original message when the cause is not recognised", () => {
    expect(explainConnectionError(new Error("panne inattendue"))).toBe("panne inattendue");
  });
});

describe("redactUri", () => {
  it("should drop the credentials when the connection string carries them", () => {
    expect(redactUri("mongodb+srv://user:motdepasse@cluster.example.net/base")).toBe(
      "mongodb+srv://cluster.example.net"
    );
  });

  it("should keep the host when the connection string has no credentials", () => {
    expect(redactUri("mongodb://127.0.0.1:27017")).toBe("mongodb://127.0.0.1:27017");
  });

  it("should state that nothing is configured when the string is absent", () => {
    expect(redactUri(undefined)).toBe("(non définie)");
  });

  it("should state that the string is unreadable when the scheme is missing", () => {
    expect(redactUri("127.0.0.1:27017")).toBe("(URI illisible)");
  });
});

describe("runMain", () => {
  const originalExitCode = process.exitCode;

  afterEach(() => {
    process.exitCode = originalExitCode;
    jest.restoreAllMocks();
  });

  it("should report the returned code as exit code when the entry point resolves", async () => {
    // Act
    await runMain(() => Promise.resolve(2));

    // Assert
    expect(process.exitCode).toBe(2);
  });

  it("should exit with code 1 when the entry point rejects", async () => {
    // Arrange
    jest.spyOn(console, "error").mockImplementation(() => {});

    // Act
    await runMain(() => Promise.reject(new Error("fermeture impossible")));

    // Assert
    expect(process.exitCode).toBe(1);
  });

  it("should log the error message when the entry point rejects", async () => {
    // Arrange
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    // Act
    await runMain(() => Promise.reject(new Error("fermeture impossible")));

    // Assert
    expect(errorSpy).toHaveBeenCalledWith("❌ Erreur inattendue : fermeture impossible");
  });
});
