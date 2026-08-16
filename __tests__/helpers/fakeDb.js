// Double de test de la couche MongoDB.
// Les modules serveur n'utilisent que `db.collection(nom)` : on expose donc un
// objet compatible dont chaque collection est un jeu de jest.fn(), pour pouvoir
// affirmer les requêtes émises sans dépendre d'une vraie base.

/**
 * Curseur mongo minimal : toutes les méthodes de chaînage renvoient le curseur,
 * `toArray` résout les documents fournis.
 */
function createCursor(docs = []) {
  const cursor = {
    sort: jest.fn(() => cursor),
    skip: jest.fn(() => cursor),
    limit: jest.fn(() => cursor),
    project: jest.fn(() => cursor),
    toArray: jest.fn(async () => docs),
  };
  return cursor;
}

function createCollection() {
  return {
    findOne: jest.fn(async () => null),
    find: jest.fn(() => createCursor([])),
    aggregate: jest.fn(() => createCursor([])),
    insertOne: jest.fn(async () => ({ insertedId: "inserted-id" })),
    insertMany: jest.fn(async () => ({ insertedCount: 0 })),
    updateOne: jest.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
    updateMany: jest.fn(async () => ({ matchedCount: 0, modifiedCount: 0 })),
    deleteOne: jest.fn(async () => ({ deletedCount: 1 })),
    deleteMany: jest.fn(async () => ({ deletedCount: 0 })),
    countDocuments: jest.fn(async () => 0),
  };
}

/**
 * Fabrique une base factice. `db.collection(nom)` renvoie toujours le même
 * double pour un nom donné, ce qui permet de préparer et d'inspecter les appels.
 */
function createFakeDb() {
  const collections = new Map();

  const collection = (name) => {
    if (!collections.has(name)) collections.set(name, createCollection());
    return collections.get(name);
  };

  return {
    db: { collection },
    /** Accès direct au double d'une collection (le crée au besoin). */
    col: collection,
    /** Réinitialise tous les doubles créés jusqu'ici. */
    reset: () => collections.clear(),
  };
}

/** Prépare le résultat du prochain `find()` d'une collection. */
function mockFind(collection, docs) {
  collection.find.mockReturnValue(createCursor(docs));
}

/** Prépare le résultat du prochain `aggregate()` d'une collection. */
function mockAggregate(collection, docs) {
  collection.aggregate.mockReturnValue(createCursor(docs));
}

module.exports = { createFakeDb, createCursor, mockFind, mockAggregate };
