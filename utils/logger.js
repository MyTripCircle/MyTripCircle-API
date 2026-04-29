const IS_PROD = process.env.NODE_ENV === "production";

// Neutralise les vecteurs d'injection de logs (CRLF) et masque les PII en production
function sanitize(...args) {
  return args.map((a) => {
    let s = String(a).replaceAll(/[\r\n]/g, " ");
    if (IS_PROD) {
      // Remplace chaque token contenant un @ par [email] sans regex complexe (évite ReDoS)
      s = s.replaceAll(/\S+/g, (token) => {
        const at = token.indexOf("@");
        return at > 0 && token.indexOf(".", at + 1) > at + 1 ? "[email]" : token;
      });
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
