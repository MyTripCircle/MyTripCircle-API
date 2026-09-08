#!/bin/bash
# Déploiement de l'API sur le VPS : récupération du code, reconstruction de
# l'image, redémarrage du conteneur.
set -euo pipefail

BRANCHE="${1:-main}"

echo "[deploy] Récupération de la branche ${BRANCHE}..."
git fetch origin "${BRANCHE}"
git checkout "${BRANCHE}"
git reset --hard "origin/${BRANCHE}"

# Le démarrage échoue volontairement si une variable requise manque. Le vérifier
# ici plutôt qu'au lancement du conteneur évite d'interrompre le service en
# place pour repartir sur une configuration incomplète.
echo "[deploy] Vérification des variables d'environnement..."
for VAR in MONGODB_URI JWT_SECRET REFRESH_SECRET ENCRYPTION_KEY HMAC_KEY ALLOWED_ORIGINS; do
  if ! grep -qE "^${VAR}=.+" .env; then
    echo "[deploy] ERREUR : ${VAR} absente ou vide dans .env — déploiement interrompu." >&2
    exit 1
  fi
done

echo "[deploy] Reconstruction de l'image..."
docker compose up --build -d

echo "[deploy] Attente de la disponibilité du service..."
for _ in $(seq 1 30); do
  if docker exec mytripcircle_api node -e "require('node:http').get('http://127.0.0.1:4000/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))" 2>/dev/null; then
    echo "[deploy] Service opérationnel."
    docker logs mytripcircle_api --tail 10
    exit 0
  fi
  sleep 2
done

echo "[deploy] ERREUR : le service n'a pas répondu dans le délai imparti." >&2
docker logs mytripcircle_api --tail 40 >&2
exit 1
