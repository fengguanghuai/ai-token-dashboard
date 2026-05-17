FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY src ./src
COPY index.html vite.config.js ./
RUN npm run build && npm prune --omit=dev

ENV PORT=4173
EXPOSE 4173

CMD ["node", "src/server.mjs"]
