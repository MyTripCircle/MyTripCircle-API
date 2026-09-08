/**
 * Journalisation assainie.
 *
 * Le passage par ce module plutôt que par `console` directement tient à deux
 * garanties qu'un appel nu ne donne pas : les retours à la ligne injectés par
 * un utilisateur ne peuvent pas fabriquer de fausses entrées, et les adresses
 * électroniques n'atteignent pas les journaux de production.
 *
 * @module utils/logger
 */

const IS_PROD = process.env.NODE_ENV === "production";

/**
 * Neutralise les entrées de journal avant écriture.
 *
 * Deux traitements. Les retours chariot et sauts de ligne sont remplacés par
 * des espaces : une valeur contrôlée par l'utilisateur qui en contient permet
 * sinon d'insérer des lignes entières dans le journal, et donc d'y faire
 * figurer des événements qui n'ont pas eu lieu ou de masquer les vrais.
 *
 * En production, tout jeton ressemblant à une adresse électronique est
 * remplacé. Les journaux sont conservés, souvent agrégés hors du serveur, et ne
 * doivent pas devenir un second entrepôt de données personnelles échappant aux
 * durées de conservation posées en base. Le masquage est levé hors production,
 * où l'adresse est nécessaire au diagnostic.
 *
 * La détection procède par découpage sur les espaces puis inspection de
 * position, et non par une expression rationnelle d'adresse : les formes
 * habituelles combinent quantificateurs imbriqués et alternances, ce qui expose
 * à un retour sur trace exponentiel — un journal étant précisément l'endroit où
 * transitent des chaînes hostiles.
 *
 * @param {...*} args Valeurs à journaliser, converties en chaînes.
 * @returns {string[]} Valeurs assainies, dans l'ordre reçu.
 */
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

/**
 * Journal applicatif.
 *
 * Les niveaux `debug` et `info` sont muets en production : ils décrivent le
 * déroulement nominal et n'ont d'utilité qu'au développement, où leur volume ne
 * pose pas de problème. Les niveaux `warn` et `error` écrivent toujours, un
 * incident de production étant précisément ce que les journaux servent à
 * reconstituer.
 *
 * @type {{
 *   debug: (...args: any[]) => void,
 *   info:  (...args: any[]) => void,
 *   warn:  (...args: any[]) => void,
 *   error: (...args: any[]) => void,
 * }}
 */
const logger = {
  debug: (...args) => { if (!IS_PROD) console.log("[debug]", ...sanitize(...args)); },
  info: (...args) => { if (!IS_PROD) console.log("[info]", ...sanitize(...args)); },
  warn: (...args) => console.warn("[warn]", ...sanitize(...args)),
  error: (...args) => console.error("[error]", ...sanitize(...args)),
};

module.exports = logger;
