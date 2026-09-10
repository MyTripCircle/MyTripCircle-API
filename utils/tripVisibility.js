/**
 * Règle unique de visibilité d'un voyage.
 *
 * Un voyage a longtemps porté deux champs décrivant la même chose : le booléen
 * historique `isPublic` et l'énumération `visibility` qui l'a remplacé. Les
 * contrôles d'accès les rapprochaient par un OU, de sorte qu'en cas de
 * divergence la valeur la plus permissive l'emportait (défaut D-01 du registre).
 * `visibility` fait désormais seule autorité ; `isPublic` n'est plus qu'un champ
 * de compatibilité, dérivé à chaque écriture et consulté uniquement pour les
 * documents antérieurs à l'énumération.
 *
 * @module utils/tripVisibility
 */

const VISIBILITIES = ["private", "friends", "public"];

/**
 * Rend la visibilité effective d'un voyage stocké.
 *
 * @param {{ visibility?: string, isPublic?: boolean }} trip Document du voyage.
 * @returns {string} `visibility` lorsqu'elle est renseignée ; à défaut, la
 *   valeur déduite du booléen historique, « privé » par défaut.
 */
function effectiveVisibility(trip) {
  if (trip.visibility) return trip.visibility;
  return trip.isPublic === true ? "public" : "private";
}

/**
 * Indique si un voyage est consultable par quiconque.
 *
 * @param {{ visibility?: string, isPublic?: boolean }} trip Document du voyage.
 * @returns {boolean} Vrai si la visibilité effective est « public ». Un
 *   `isPublic` resté à vrai ne rend plus public un voyage déclaré privé.
 */
function isTripPublic(trip) {
  return effectiveVisibility(trip) === "public";
}

/**
 * Déduit la visibilité demandée par une requête d'écriture.
 *
 * `visibility` prime lorsqu'elle est fournie ; le booléen n'est retenu que
 * pour les appelants qui n'envoient que lui.
 *
 * @param {{ visibility?: string, isPublic?: boolean }} data Corps de requête.
 * @returns {string|undefined} Visibilité demandée, ou `undefined` si la
 *   requête ne porte aucun des deux champs.
 */
function requestedVisibility({ visibility, isPublic }) {
  if (visibility !== undefined) return visibility;
  if (isPublic !== undefined) return isPublic ? "public" : "private";
  return undefined;
}

/**
 * Vérifie qu'une visibilité appartient à l'énumération.
 *
 * @param {*} visibility Valeur candidate.
 * @returns {boolean} Vrai pour « private », « friends » ou « public ».
 */
function isValidVisibility(visibility) {
  return VISIBILITIES.includes(visibility);
}

module.exports = { effectiveVisibility, isTripPublic, requestedVisibility, isValidVisibility };
