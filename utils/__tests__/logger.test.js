describe("logger", () => {
  let logSpy;
  let warnSpy;
  let errorSpy;

  beforeEach(() => {
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    jest.resetModules();
  });

  it("should replace carriage returns and line feeds with spaces (anti log-injection)", () => {
    const logger = require("../logger");
    logger.warn("ligne1\nligne2");
    expect(warnSpy).toHaveBeenCalledWith("[warn]", "ligne1 ligne2");
    warnSpy.mockClear();
    logger.warn("ligne1\r\nligne2");
    expect(warnSpy).toHaveBeenCalledWith("[warn]", "ligne1  ligne2");
  });

  it("should log debug/info on console.log outside production", () => {
    const logger = require("../logger");
    logger.debug("hello");
    logger.info("world");
    expect(logSpy).toHaveBeenCalledWith("[debug]", "hello");
    expect(logSpy).toHaveBeenCalledWith("[info]", "world");
  });

  it("should silence debug/info in production but keep warn/error", () => {
    const previousEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    jest.isolateModules(() => {
      const logger = require("../logger");
      logger.debug("secret");
      logger.info("secret");
      logger.warn("attention");
      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith("[warn]", "attention");
    });
    process.env.NODE_ENV = previousEnv;
  });

  it("should mask email-like tokens in production", () => {
    const previousEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    jest.isolateModules(() => {
      const logger = require("../logger");
      logger.error("échec pour user@example.com sur la ressource");
      expect(errorSpy).toHaveBeenCalledWith(
        "[error]",
        "échec pour [email] sur la ressource",
      );
    });
    process.env.NODE_ENV = previousEnv;
  });
});
