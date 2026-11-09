# MDF x402 v2 facilitator — self-hosted, no telemetry, no hosted dependency.
#
# The signer key is NOT in the image: it is a bind-mounted file at
# /run/secrets/facilitator_signer_key, mode 600, owned by uid 1000.
FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=8080

WORKDIR /app

# Dependency layer first so a source change does not invalidate it.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY src ./src

# Non-root, and the same uid the key file must be owned by.
USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# An ENTRYPOINT (not just CMD) is load-bearing on Unraid: the Tailscale hook
# derives ORG_ENTRYPOINT from the image's Entrypoint and re-execs it once the
# tailnet is up. With CMD only, ORG_ENTRYPOINT is empty and the hook exits
# without ever starting the service.
ENTRYPOINT ["node", "/app/src/index.ts"]
