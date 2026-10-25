# Divvy: one Node process serving the API and the built client, with SQLite
# on a volume (D1, D2), published only on the tailnet (D4). The loopback bind
# and start.sh's refusal of any other HOST keep Fly's network out; the tailnet
# policy limits which peers get in. Built for Fly.io; see fly.toml and
# docs/deploy.md.

# ---- tools: fetch Tailscale and Litestream, pinned by version and sha256 ----
# amd64 only, matching Fly's shared-cpu-1x. Changing architecture means
# changing both URLs and both sums. To bump a tool, change its two ARGs
# (docs/deploy.md, "Bumping Tailscale or Litestream").
FROM node:22-bookworm-slim AS tools
WORKDIR /tools

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

ARG TAILSCALE_VERSION=1.104.2
ARG TAILSCALE_SHA256=512f613ed7d04fc7282f7dc5bd76aa105aae28168fbb9357eb749ebcbc29f0ae
ARG LITESTREAM_VERSION=0.5.17
ARG LITESTREAM_SHA256=a191a0928884d1820fab1f866ede1d0d5811c323d0587bf863a43481a82a7668

# Only the two binaries leave the archive; its systemd units stay behind.
RUN curl -fsSL -o tailscale.tgz \
    "https://pkgs.tailscale.com/stable/tailscale_${TAILSCALE_VERSION}_amd64.tgz" \
  && echo "${TAILSCALE_SHA256}  tailscale.tgz" | sha256sum -c - \
  && tar -xzf tailscale.tgz --strip-components=1 \
    "tailscale_${TAILSCALE_VERSION}_amd64/tailscale" \
    "tailscale_${TAILSCALE_VERSION}_amd64/tailscaled"

# `dpkg-deb -x` unpacks without installing, so no systemd unit or default
# /etc/litestream.yml lands anywhere; only usr/bin/litestream is kept.
RUN curl -fsSL -o litestream.deb \
    "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-${LITESTREAM_VERSION}-linux-x86_64.deb" \
  && echo "${LITESTREAM_SHA256}  litestream.deb" | sha256sum -c - \
  && dpkg-deb -x litestream.deb litestream-deb \
  && cp litestream-deb/usr/bin/litestream ./litestream

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

# ---- runtime: only what start.sh needs to migrate and serve ----
FROM node:22-bookworm-slim
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3005 \
    DATABASE_PATH=/data/divvy.sqlite3

# Tailscale and Litestream are Go binaries that need the system's CA roots to
# reach the control plane and the backup bucket; the slim image has none.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=tools /tools/tailscale /tools/tailscaled /tools/litestream /usr/local/bin/

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# start.sh runs `npm run migrate:latest` (knex against this knexfile) before
# the server starts, so the migrations ship as source (#255).
COPY --from=build /app/server/db/knexfile.js ./server/db/knexfile.js
COPY --from=build /app/server/db/migrations ./server/db/migrations

# The boot path: join the tailnet, publish the app there, then migrate and
# start the server.
# chmod as well as git's exec bit, so any builder gets a runnable script.
COPY --from=build /app/scripts/start.sh ./scripts/start.sh
RUN chmod 755 /app/scripts/start.sh
# start.sh replicates under Litestream when this file exists (D2, #24).
COPY litestream.yml /app/litestream.yml

# The SQLite file and Tailscale's state live on a volume mounted here
# (fly.toml [mounts]).
# The process runs as root: tailscaled needs it, and Fly mounts volumes
# root-owned. Dropping privileges is a recorded follow-up. Root here is root
# in a Firecracker VM, not on the host.
RUN mkdir -p /data
VOLUME /data

EXPOSE 3005
CMD ["/app/scripts/start.sh"]
