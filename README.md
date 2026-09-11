# MyTripCircle — API

API REST de MyTripCircle : gestion des voyages collaboratifs, des réservations,
du carnet d'adresses et du réseau d'amis. Elle est consommée par deux clients
distincts, [MyTripCircle-Mobile](https://github.com/MyTripCircle/MyTripCircle-Mobile)
et [MyTripCircle-Web](https://github.com/MyTripCircle/MyTripCircle-Web), et
constitue la seule source de vérité côté données.

## Prérequis

- Node.js **22.x** ou supérieur
- Une instance MongoDB (Atlas ou locale)

## Installation et lancement

```bash
npm ci
cp .env.example .env    # puis renseigner les valeurs
npm run dev             # rechargement à chaud
npm start               # exécution simple
```

L'API écoute sur le port défini par `API_PORT` (4000 par défaut).

## Variables d'environnement

Toutes sont décrites dans `.env.example`. Les plus sensibles :

| Variable | Rôle |
|---|---|
| `MONGODB_URI`, `DB_NAME` | Connexion à la base |
| `JWT_SECRET`, `REFRESH_SECRET` | Signature des jetons d'accès et de rafraîchissement |
| `ENCRYPTION_KEY`, `HMAC_KEY` | Chiffrement AES-256-GCM des données personnelles en base |
| `ALLOWED_ORIGINS` | Origines autorisées par CORS — doit lister les deux clients |
| `MAIL_USER`, `MAIL_PASS` | Envoi des courriels transactionnels |

`ENCRYPTION_KEY` et `HMAC_KEY` ne se changent pas à la légère : les données
déjà en base sont chiffrées avec, une clé différente les rend illisibles.

## Points d'entrée

`/users` · `/trips` · `/bookings` · `/addresses` · `/invitations` · `/friends`
· `/calendar` · `/itinerary` · `/places` · `/moderation` · `/subscriptions`

Les routes légales et l'état de santé sont montés à la racine.

## Structure

```
├── index.js            # point d'entrée, démarrage du serveur
├── app.js              # assemblage Express, intergiciels, montage des routes
├── config.js           # lecture et validation des variables d'environnement
├── db.js               # connexion MongoDB, validateur de users, index
├── routes/             # 18 routeurs, un par domaine métier
├── middleware/         # authentification, journal d'audit, quotas, erreurs
├── services/           # logique métier réutilisable
├── utils/              # chiffrement, courriels, journalisation, validateurs
├── scripts/            # peuplement, diagnostic, compte de test pour k6
└── __tests__/          # helpers partagés et tests d'intégration
```

## Tests

```bash
npm test                # suite complète
npm run test:coverage   # avec rapport de couverture
```

Les tests s'exécutent contre une base en mémoire (`mongodb-memory-server`) :
aucune instance réelle n'est sollicitée.

## Déploiement

L'API tourne en conteneur derrière Traefik, qui termine TLS et route
`mytripcircle-api.enzo-turpin.fr` vers le port 4000.

```bash
git clone https://github.com/MyTripCircle/MyTripCircle-API.git
cd MyTripCircle-API
cp .env.example .env    # puis renseigner les valeurs de production
./deploy.sh             # ou ./deploy.sh develop pour déployer une autre branche
```

`deploy.sh` contrôle la présence des variables requises **avant** de reconstruire
l'image, puis attend que `/health` réponde avant de rendre la main. Un
déploiement qui échoue laisse donc le service précédent en place.

### Points de vigilance

`ENCRYPTION_KEY` et `HMAC_KEY` doivent rester identiques à celles déjà en
service : les données personnelles en base sont chiffrées avec, une clé
différente les rend illisibles.

`ALLOWED_ORIGINS` est obligatoire en production. L'API refuse de démarrer sans
elle, l'authentification par témoin de connexion interdisant le joker CORS. Y
lister les deux clients, séparés par des virgules.

Le réseau Docker `network_web` est externe et doit préexister :

```bash
docker network create network_web
```

## Contribuer

Les conventions du projet — format des commits, nommage des branches, standards
de code — sont décrites dans `CLAUDE.md` à la racine des dépôts clients.
Toute modification passe par une pull request avec CI verte.

## Licence

Projet privé — tous droits réservés.
