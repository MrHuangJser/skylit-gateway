# Session sidecar: a normal headless Chromium that signs in with the owner's
# credentials and exports only a SHORT-LIVED token snapshot for the gateway.
# The Playwright base image already contains Chromium and all system libraries.
FROM mcr.microsoft.com/playwright:v1.58.2-noble

WORKDIR /app
# Reuse the browser bundled in the base image; do not download another copy.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_ENV=production

COPY validation/package.json validation/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

COPY validation/session-sidecar.mjs validation/session-refresh-policy.mjs ./

# Non-root: the base image ships an `ubuntu` user (uid 1000).
RUN mkdir -p /state /session && chown -R 1000:1000 /state /session /app
USER 1000:1000

ENTRYPOINT ["node", "/app/session-sidecar.mjs"]
