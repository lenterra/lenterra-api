# Build context is the repository root, so the workspace lockfile is available
# and the image is reproducible.
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY verifier/package.json verifier/
COPY packages/core/package.json packages/core/
COPY modules/package.json modules/
RUN npm ci --workspace @lenterra/verifier --include-workspace-root

COPY tsconfig.base.json ./
COPY verifier verifier/
RUN npm run build --workspace @lenterra/verifier

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY verifier/package.json verifier/
RUN npm ci --omit=dev --workspace @lenterra/verifier --include-workspace-root \
  && npm cache clean --force

COPY --from=build /app/verifier/dist verifier/dist

# The verifier holds the assertion secret and nothing else. It runs unprivileged
# because a compromise here mints identities for the whole system.
USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.VERIFIER_PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "verifier/dist/index.js"]
