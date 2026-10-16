# The server only: the Mac scrapes and uploads (docs/superpowers/specs/2026-10-16-deployment-design.md).
# No Chromium, so puppeteer's browser download is skipped.
FROM node:24.22-bookworm-slim
ENV NODE_ENV=production PUPPETEER_SKIP_DOWNLOAD=true HOST=0.0.0.0 PORT=3030
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node . .
# The volume mounts here; created owned by node so a new named volume starts writable.
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3030
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:3030/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "server.js"]
