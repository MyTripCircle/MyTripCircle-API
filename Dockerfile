# Node 22 : la version que déclare `engines` et que valide l'intégration continue.
FROM node:22-alpine

WORKDIR /app

# Les dépendances sont installées avant la copie du code : tant que le manifeste
# et le verrou ne changent pas, la couche est réutilisée d'un déploiement à
# l'autre. `npm ci` s'en tient au verrou, là où `npm install` pourrait résoudre
# des versions différentes de celles validées par l'intégration continue.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY . .

# Le processus ne tourne pas en root : une exécution de code arbitraire dans le
# conteneur n'y obtient alors aucun privilège d'administration.
RUN addgroup -g 1001 appgroup \
 && adduser -D -u 1001 -G appgroup appuser \
 && chown -R appuser:appgroup /app
USER appuser

EXPOSE 4000

CMD ["node", "index.js"]
