const IS_PROD = process.env.NODE_ENV === "production";

// Neutralise les vecteurs d'injection de logs (CRLF) et masque les PII en production
function sanitize(...args) {
  return args.map((a) => {
    let s = String(a).replaceAll(/[\r\n]/g, " ");
    if (IS_PROD) {
      s = s.replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, "[email]");
    }
    return s;
  });
}

const logger = {
  debug: (...args) => { if (!IS_PROD) console.log("[debug]", ...sanitize(...args)); },
  info: (...args) => { if (!IS_PROD) console.log("[info]", ...sanitize(...args)); },
  warn: (...args) => console.warn("[warn]", ...sanitize(...args)),
  error: (...args) => console.error("[error]", ...sanitize(...args)),
};

module.exports = logger;
