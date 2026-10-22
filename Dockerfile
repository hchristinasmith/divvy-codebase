# Divvy: one Node process serving the API and the built client, with SQLite
# on a volume (D1, D2). Built for Fly.io; see fly.toml.

# ---- build: install everything, build client + server, drop dev deps ----
FROM node:22-bookworm-slim AS build
WORKDIR /app

# sqlite3 is a native module. It normally installs a prebuilt binary; these
# let it compile from source when no prebuilt matches.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev

# ---- runtime: only what `npm start` needs ----
FROM node:22-bookworm-slim
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3005 \
    DATABASE_PATH=/data/divvy.sqlite3

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# `npm start` runs `knex migrate:latest` against this knexfile before the
# server starts, so the migrations ship as source.
COPY --from=build /app/server/db/knexfile.js ./server/db/knexfile.js
COPY --from=build /app/server/db/migrations ./server/db/migrations

# The SQLite file lives on a volume mounted here (fly.toml [mounts]).
RUN mkdir -p /data
VOLUME /data

EXPOSE 3005
CMD ["npm", "start"]
