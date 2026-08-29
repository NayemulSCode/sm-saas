# The application image. One image, three commands: app, worker, migrate.
#
# Building one image rather than three means the code that runs the migration is
# byte-identical to the code that runs the request — which is the whole point,
# because a migration built from a different commit than the app it migrates for
# is the failure that produces "column does not exist" in production.

# ── deps ─────────────────────────────────────────────────────────────────────
# Separate stage so a change to source does not reinstall node_modules.
FROM node:24-alpine AS deps
WORKDIR /app

# @node-rs/argon2 ships prebuilt binaries; libc6-compat is what lets them load
# on Alpine's musl.
RUN apk add --no-cache libc6-compat

COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile

# ── build ────────────────────────────────────────────────────────────────────
FROM node:24-alpine AS build
WORKDIR /app
RUN apk add --no-cache libc6-compat
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# The build needs these to satisfy the env schema at import time. They are
# BUILD-TIME PLACEHOLDERS and never reach the image: the runtime values come
# from the host's env_file. A real secret baked into a layer is a secret in
# every registry that ever holds the image.
ENV APP_URL=http://localhost:3000 \
    PLATFORM_HOST=admin.localhost \
    SESSION_SECRET=build-time-placeholder-not-a-real-secret \
    ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 \
    NEXT_TELEMETRY_DISABLED=1

RUN corepack enable && pnpm build

# ── runtime ──────────────────────────────────────────────────────────────────
FROM node:24-alpine AS runtime
WORKDIR /app

RUN apk add --no-cache libc6-compat tini

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    TZ=Asia/Dhaka

# `output: 'standalone'` traces exactly the files the server needs, which is why
# the runtime stage carries no pnpm, no lockfile and no source.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static

# No `public/` COPY. The directory does not exist — every asset so far is
# imported through the bundler, which fingerprints it. Add the COPY back on the
# day a favicon or a font file lands, not before: a COPY of a missing path
# fails the build rather than being ignored.

# The worker and the migration runner are not part of the Next build, so they
# need their own dependencies and their own entry points.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/tsconfig.json ./tsconfig.json

# node:alpine ships a `node` user at 1000. Running as root inside a container
# that terminates TLS-adjacent traffic buys nothing and costs a privilege
# boundary.
USER node

EXPOSE 3000

# tini reaps zombies and forwards signals, so `docker stop` drains rather than
# killing mid-request. Without an init, PID 1 in Node ignores SIGTERM by
# default and the container is SIGKILLed ten seconds later.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
