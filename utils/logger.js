const IS_PROD = process.env.NODE_ENV === "production";

const logger = {
  debug: (...args) => { if (!IS_PROD) console.log("[debug]", ...args); },
  info: (...args) => { if (!IS_PROD) console.log("[info]", ...args); },
  warn: (...args) => console.warn("[warn]", ...args),
  error: (...args) => console.error("[error]", ...args),
};

module.exports = logger;
