/**
 * Jeu de données de démonstration de MyTripCircle.
 *
 * Ce module ne connaît ni la connexion ni les écritures : il ne produit que des
 * documents. La séparation rend le jeu de données vérifiable par un test
 * unitaire — cohérence des références entre collections, absence de donnée
 * personnelle — sans qu'une base soit joignable, et laisse à `scripts/seed.js`
 * la seule responsabilité de les écrire.
 *
 * CONFIDENTIALITÉ — Aucune donnée à caractère personnel réelle ne figure ici,
 * et il ne doit jamais en être ajouté :
 * - les adresses e-mail utilisent `example.com`, domaine réservé à la
 *   documentation par la RFC 2606, qui ne peut recevoir de courrier ;
 * - les numéros appartiennent à la plage `+3363998xxxx`, réservée par l'ARCEP
 *   à la fiction et jamais attribuée à un abonné ;
 * - les noms, adresses postales et numéros de réservation sont inventés ;
 * - aucun secret, aucune clé, aucun jeton n'est écrit en dur : l'empreinte du
 *   mot de passe de démonstration est calculée par l'appelant et injectée.
 *
 * Les identifiants sont figés et préfixés `5eed` afin que la ré-exécution du
 * script mette à jour les mêmes documents au lieu d'en créer de nouveaux, et
 * que le jeu de démonstration reste reconnaissable au milieu d'autres données.
 *
 * @module scripts/seed-dataset
 */

const { ObjectId } = require("mongodb");
const {
  encrypt,
  hashField,
  encryptUserFields,
  encryptAddressFields,
} = require("../utils/crypto");

/** Millisecondes dans une journée, pour dater le jeu relativement à l'instant courant. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Identifiants figés du jeu de démonstration, par collection.
 *
 * Ils servent deux usages : rendre l'alimentation idempotente (écriture par
 * `_id`) et permettre au script de distinguer ses propres documents de ceux
 * qu'il n'a pas écrits, afin de ne jamais toucher aux seconds.
 */
const DEMO_IDS = {
  users: {
    alice: new ObjectId("5eed00000000000000000a01"),
    bruno: new ObjectId("5eed00000000000000000a02"),
    chloe: new ObjectId("5eed00000000000000000a03"),
  },
  trips: {
    porto: new ObjectId("5eed00000000000000000b01"),
    ecosse: new ObjectId("5eed00000000000000000b02"),
  },
  bookings: {
    vol: new ObjectId("5eed00000000000000000c01"),
    hotel: new ObjectId("5eed00000000000000000c02"),
    restaurant: new ObjectId("5eed00000000000000000c03"),
    activite: new ObjectId("5eed00000000000000000c04"),
  },
  addresses: {
    hotelPorto: new ObjectId("5eed00000000000000000d01"),
    restaurantPorto: new ObjectId("5eed00000000000000000d02"),
    distillerie: new ObjectId("5eed00000000000000000d03"),
  },
  friends: {
    aliceVersBruno: new ObjectId("5eed00000000000000000e01"),
    brunoVersAlice: new ObjectId("5eed00000000000000000e02"),
  },
  subscriptions: {
    alice: new ObjectId("5eed00000000000000000f01"),
  },
};

/**
 * Comptes de démonstration, en clair.
 *
 * Le mot de passe n'est pas un secret : il est identique pour les trois
 * comptes, documenté dans le README et n'a de valeur que sur une base de
 * démonstration locale. Il respecte la politique de
 * `server/utils/authHelpers.isStrongPassword`, sans quoi ces comptes ne
 * pourraient pas être recréés par l'application elle-même.
 */
const DEMO_PASSWORD = "Demo!Passw0rd";

const DEMO_USERS = [
  { key: "alice", name: "Alice Démo", email: "alice.demo@example.com", phone: "+33639980001" },
  { key: "bruno", name: "Bruno Démo", email: "bruno.demo@example.com", phone: "+33639980002" },
  { key: "chloe", name: "Chloé Démo", email: "chloe.demo@example.com", phone: null },
];

/** Quotas d'un abonnement payant, alignés sur `scripts/grant-premium.js`. */
const PREMIUM_FEATURES = {
  maxTrips: -1,
  maxCollaborators: -1,
  canExport: true,
  prioritySupport: true,
  maxAttachments: -1,
};

/** Date décalée de `days` jours par rapport à la référence, à minuit passé inclus. */
function shiftDays(reference, days) {
  return new Date(reference.getTime() + days * DAY_MS);
}

/**
 * Construit les documents `users`.
 *
 * Les comptes sont créés vérifiés : un compte en attente d'OTP se verrait
 * refuser la connexion, ce qui priverait le jeu de démonstration de son seul
 * usage. Le chiffrement passe par les mêmes utilitaires que le serveur, afin
 * que les empreintes de recherche soient celles que l'application interroge.
 */
function buildUsers(now, passwordHash) {
  return DEMO_USERS.map((user) =>
    encryptUserFields({
      _id: DEMO_IDS.users[user.key],
      name: user.name,
      email: user.email,
      password: passwordHash,
      ...(user.phone ? { phone: user.phone } : {}),
      verified: true,
      createdAt: now,
      updatedAt: now,
    })
  );
}

/**
 * Construit les documents `trips`.
 *
 * Les dates sont postérieures à l'instant courant : l'application interdit la
 * création d'un voyage démarrant dans le passé, un jeu daté en dur vieillirait
 * et cesserait de représenter un état atteignable par l'utilisateur.
 */
function buildTrips(now) {
  const ownerId = String(DEMO_IDS.users.alice);
  const collaborator = {
    userId: String(DEMO_IDS.users.bruno),
    role: "editor",
    joinedAt: now,
    permissions: { canEdit: true, canInvite: true, canDelete: false },
  };

  return [
    {
      _id: DEMO_IDS.trips.porto,
      title: "Week-end à Porto",
      description: "Trois jours entre bords du Douro et caves de Vila Nova de Gaia.",
      destination: "Porto, Portugal",
      coverImage: null,
      startDate: shiftDays(now, 30),
      endDate: shiftDays(now, 33),
      ownerId,
      collaborators: [collaborator],
      isPublic: false,
      visibility: "friends",
      status: "validated",
      tags: ["city-break", "gastronomie"],
      stats: { totalBookings: 3, totalAddresses: 2, totalCollaborators: 1 },
      location: { type: "Point", coordinates: [0, 0] },
      createdAt: now,
      updatedAt: now,
    },
    {
      _id: DEMO_IDS.trips.ecosse,
      title: "Road trip en Écosse",
      description: "Boucle Édimbourg — Highlands — Skye, encore à l'état d'ébauche.",
      destination: "Édimbourg, Écosse",
      coverImage: null,
      startDate: shiftDays(now, 90),
      endDate: shiftDays(now, 100),
      ownerId,
      collaborators: [],
      isPublic: true,
      visibility: "public",
      status: "draft",
      tags: ["road-trip", "nature"],
      stats: { totalBookings: 1, totalAddresses: 1, totalCollaborators: 0 },
      location: { type: "Point", coordinates: [0, 0] },
      createdAt: now,
      updatedAt: now,
    },
  ];
}

/**
 * Construit les documents `bookings`.
 *
 * Les quatre types couverts — vol, hôtel, restaurant, activité — sont ceux que
 * l'interface affiche différemment ; un jeu qui n'en couvrirait qu'un laisserait
 * des écrans vides à la démonstration. Les numéros de confirmation sont
 * inventés et ne correspondent à aucune réservation réelle.
 */
function buildBookings(now) {
  const userId = String(DEMO_IDS.users.alice);
  const portoId = String(DEMO_IDS.trips.porto);

  return [
    {
      _id: DEMO_IDS.bookings.vol,
      tripId: portoId,
      type: "flight",
      title: "Paris CDG → Porto OPO",
      description: "Vol aller, bagage cabine inclus.",
      date: shiftDays(now, 30),
      time: "07:45",
      confirmationNumber: "DEMO-AB1234",
      price: 89.9,
      currency: "EUR",
      status: "confirmed",
      attachments: [],
      userId,
      createdAt: now,
      updatedAt: now,
    },
    {
      _id: DEMO_IDS.bookings.hotel,
      tripId: portoId,
      type: "hotel",
      title: "Hôtel du Douro (démo)",
      description: "Chambre double, petit-déjeuner compris.",
      date: shiftDays(now, 30),
      endDate: shiftDays(now, 33),
      address: "12 rua de la Démonstration, Porto",
      confirmationNumber: "DEMO-HT5678",
      price: 320,
      currency: "EUR",
      status: "confirmed",
      attachments: [],
      userId,
      createdAt: now,
      updatedAt: now,
    },
    {
      _id: DEMO_IDS.bookings.restaurant,
      tripId: portoId,
      type: "restaurant",
      title: "Dîner Cantina Fictícia",
      date: shiftDays(now, 31),
      time: "20:00",
      address: "4 travessa des Exemples, Porto",
      price: 45,
      currency: "EUR",
      status: "pending",
      attachments: [],
      userId,
      createdAt: now,
      updatedAt: now,
    },
    {
      _id: DEMO_IDS.bookings.activite,
      tripId: String(DEMO_IDS.trips.ecosse),
      type: "activity",
      title: "Visite d'une distillerie (démo)",
      date: shiftDays(now, 92),
      time: "14:30",
      price: 25,
      currency: "GBP",
      status: "pending",
      attachments: [],
      userId,
      createdAt: now,
      updatedAt: now,
    },
  ];
}

/**
 * Construit les documents `addresses`.
 *
 * Le nom et la voie sont chiffrés comme le fait l'application : un jeu écrit en
 * clair passerait l'insertion mais s'afficherait en charabia après déchiffrement
 * côté lecture, et donnerait à croire que le chiffrement est facultatif.
 */
function buildAddresses(now) {
  const userId = String(DEMO_IDS.users.alice);

  return [
    encryptAddressFields({
      _id: DEMO_IDS.addresses.hotelPorto,
      type: "hotel",
      name: "Hôtel du Douro (démo)",
      address: "12 rua de la Démonstration",
      city: "Porto",
      country: "Portugal",
      notes: "Réception ouverte 24 h/24.",
      rating: 4,
      tripId: String(DEMO_IDS.trips.porto),
      userId,
      createdAt: now,
      updatedAt: now,
    }),
    encryptAddressFields({
      _id: DEMO_IDS.addresses.restaurantPorto,
      type: "restaurant",
      name: "Cantina Fictícia",
      address: "4 travessa des Exemples",
      city: "Porto",
      country: "Portugal",
      notes: "Réserver la veille.",
      rating: 5,
      tripId: String(DEMO_IDS.trips.porto),
      userId,
      createdAt: now,
      updatedAt: now,
    }),
    encryptAddressFields({
      _id: DEMO_IDS.addresses.distillerie,
      type: "activity",
      name: "Distillerie d'exemple",
      address: "1 fictional road",
      city: "Aviemore",
      country: "Écosse",
      rating: 4,
      tripId: String(DEMO_IDS.trips.ecosse),
      userId,
      createdAt: now,
      updatedAt: now,
    }),
  ];
}

/**
 * Construit les documents `friends`.
 *
 * La relation est écrite dans les deux sens, comme le fait l'acceptation d'une
 * demande d'ami : le serveur lit toujours `friends` par `userId`, un seul
 * document rendrait l'amitié visible d'un côté seulement. Les champs recopiés
 * du profil sont chiffrés, à l'identique du chemin applicatif.
 */
function buildFriends(now) {
  const alice = DEMO_USERS.find((user) => user.key === "alice");
  const bruno = DEMO_USERS.find((user) => user.key === "bruno");

  return [
    {
      _id: DEMO_IDS.friends.aliceVersBruno,
      userId: String(DEMO_IDS.users.alice),
      friendId: String(DEMO_IDS.users.bruno),
      name: encrypt(bruno.name),
      email: encrypt(bruno.email),
      phone: encrypt(bruno.phone),
      createdAt: now,
    },
    {
      _id: DEMO_IDS.friends.brunoVersAlice,
      userId: String(DEMO_IDS.users.bruno),
      friendId: String(DEMO_IDS.users.alice),
      name: encrypt(alice.name),
      email: encrypt(alice.email),
      phone: encrypt(alice.phone),
      createdAt: now,
    },
  ];
}

/**
 * Construit les documents `subscriptions`.
 *
 * Un seul compte est abonné : la démonstration doit montrer les deux régimes de
 * quotas, celui de l'offre gratuite comme celui de l'offre payante. La
 * plateforme `manual` signale une attribution hors magasin d'applications, sans
 * reçu à valider — aucun identifiant de transaction réel n'est donc inventé.
 */
function buildSubscriptions(now) {
  const endDate = shiftDays(now, 365);

  return [
    {
      _id: DEMO_IDS.subscriptions.alice,
      userId: String(DEMO_IDS.users.alice),
      plan: "premium",
      status: "active",
      platform: "manual",
      productId: "demo.seed",
      transactionId: null,
      features: PREMIUM_FEATURES,
      startDate: now,
      endDate,
      nextBillingDate: endDate,
      cancelledAt: null,
      createdAt: now,
      updatedAt: now,
    },
  ];
}

/**
 * Assemble le jeu complet, collection par collection.
 *
 * L'instant de référence est un paramètre et non `new Date()` capturé en
 * interne, pour que le contenu produit soit reproductible sous test.
 *
 * @param {object} options
 * @param {Date} options.now Instant de référence des dates produites.
 * @param {string} options.passwordHash Empreinte bcrypt du mot de passe de
 *   démonstration, calculée par l'appelant.
 * @returns {Array<{ name: string, documents: object[] }>} Collections à écrire,
 *   dans un ordre sans importance : chaque document porte son `_id`.
 * @throws {Error} Si les clés de chiffrement ne sont pas configurées.
 */
function buildDataset({ now, passwordHash }) {
  return [
    { name: "users", documents: buildUsers(now, passwordHash) },
    { name: "trips", documents: buildTrips(now) },
    { name: "bookings", documents: buildBookings(now) },
    { name: "addresses", documents: buildAddresses(now) },
    { name: "friends", documents: buildFriends(now) },
    { name: "subscriptions", documents: buildSubscriptions(now) },
  ];
}

/**
 * Empreinte de recherche des adresses e-mail de démonstration.
 *
 * Exposée pour que le script d'alimentation puisse repérer un compte de
 * démonstration créé sans `_id` figé — cas d'un jeu antérieur — et éviter la
 * collision avec l'index unique posé sur `emailHash`.
 *
 * @returns {string[]} Empreintes des trois comptes.
 * @throws {Error} Si les clés de chiffrement ne sont pas configurées.
 */
function demoEmailHashes() {
  return DEMO_USERS.map((user) => hashField(user.email));
}

module.exports = {
  DEMO_IDS,
  DEMO_USERS,
  DEMO_PASSWORD,
  PREMIUM_FEATURES,
  buildDataset,
  demoEmailHashes,
};
