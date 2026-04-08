const IS_PROD = process.env.NODE_ENV === "production";

// Neutralise les vecteurs d'injection de logs (CRLF injection)
function sanitize(...args) {
  return args.map((a) => String(a).replace(/[\r\n]/g, " "));
}

const logger = {
  debug: (...args) => { if (!IS_PROD) console.log("[debug]", ...sanitize(...args)); },
  info: (...args) => { if (!IS_PROD) console.log("[info]", ...sanitize(...args)); },
  warn: (...args) => console.warn("[warn]", ...sanitize(...args)),
  error: (...args) => console.error("[error]", ...sanitize(...args)),
};

module.exports = logger;
