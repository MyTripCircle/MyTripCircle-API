/**
 * Contrôles de forme sur les coordonnées saisies.
 *
 * Les expressions employées ici sont volontairement simples et bornées. Une
 * validation exhaustive au sens de la RFC 5322 exigerait un motif à
 * quantificateurs imbriqués, exposé au retour sur trace exponentiel sur une
 * entrée hostile — un risque hors de proportion avec le gain, puisque seule
 * l'existence réelle d'une adresse compte et qu'elle ne s'établit que par
 * l'envoi d'un code de vérification.
 *
 * @module utils/validators
 */

/**
 * Vérifie qu'une adresse électronique a une forme plausible.
 *
 * Les longueurs de la partie locale et du domaine sont bornées explicitement
 * dans le motif, ce qui écarte les entrées démesurées avant qu'elles
 * n'atteignent la base ou le service d'envoi.
 *
 * @param {*} email Valeur candidate, de type non garanti.
 * @returns {boolean} Vrai si la forme est acceptable. Faux pour toute valeur
 *   non textuelle. N'atteste en rien que l'adresse existe.
 */
function isValidEmail(email) {
  return typeof email === "string" && /^[a-zA-Z0-9._%+-]{1,64}@[a-zA-Z0-9.-]{1,253}\.[a-zA-Z]{2,}$/.test(email);
}

/**
 * Vérifie qu'un numéro de téléphone a une forme plausible.
 *
 * Les séparateurs usuels — espaces, points, tirets, parenthèses — sont admis
 * plutôt qu'imposés : les conventions d'écriture varient d'un pays à l'autre et
 * exiger un format unique ferait rejeter des numéros valides saisis
 * correctement. La normalisation nécessaire à la recherche est assurée en aval
 * par l'empreinte, non par cette validation.
 *
 * @param {*} phone Valeur candidate, de type non garanti.
 * @returns {boolean} Vrai si la forme est acceptable. Faux pour toute valeur
 *   non textuelle. N'atteste en rien que le numéro est attribué.
 */
function isValidPhone(phone) {
  return typeof phone === "string" && /^\+?[\d\s().-]{7,20}$/.test(phone);
}

module.exports = { isValidEmail, isValidPhone };
