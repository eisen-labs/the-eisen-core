FROM oven/bun:1 AS base
WORKDIR /app

# ── Install production dependencies ──────────────────
FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ── Final image ──────────────────────────────────────
FROM base AS runner

# Run as non-root for security
RUN groupadd --system --gid 1001 eisen && \
    useradd --system --uid 1001 --gid eisen --no-create-home eisen

COPY --from=deps --chown=eisen:eisen /app/node_modules ./node_modules
COPY --chown=eisen:eisen src ./src
COPY --chown=eisen:eisen tsconfig.json ./

USER eisen

ENV NODE_ENV=production
EXPOSE 8080

# Cloud Run sends SIGTERM on scale-down; Bun handles it gracefully
CMD ["bun", "src/index.ts"]
