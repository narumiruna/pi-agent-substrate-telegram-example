FROM node:26.8.2-bookworm-slim@sha256:6e685d638c472d81fdf86b944e3487f0d3b5e747d5099f936d4d2256cd1201d5 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src/substrate ./src/substrate
COPY tests/substrate-identity.ts ./tests/substrate-identity.ts
COPY tests/identity/tsconfig.json ./tests/identity/tsconfig.json
RUN ./node_modules/.bin/tsc -p tests/identity/tsconfig.json && npm prune --omit=dev --ignore-scripts

FROM node:26.8.2-bookworm-slim@sha256:6e685d638c472d81fdf86b944e3487f0d3b5e747d5099f936d4d2256cd1201d5
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.cache/identity-build ./build
USER 1000:1000
CMD ["node", "-e", "setTimeout(() => {}, 86400000)"]
