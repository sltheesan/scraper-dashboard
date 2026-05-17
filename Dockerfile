# Microsoft's Playwright image ships with all browser deps preinstalled.
# Pin to the version that matches `playwright` in package.json.
FROM mcr.microsoft.com/playwright:v1.60.0-jammy

# Install Google Chrome stable so that scraper.js can launch with
# `channel: 'chrome'` at runtime (matches our dev setup on macOS).
RUN apt-get update \
 && apt-get install -y --no-install-recommends wget gnupg ca-certificates \
 && wget -qO- https://dl.google.com/linux/linux_signing_key.pub \
      | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
 && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
      > /etc/apt/sources.list.d/google-chrome.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends google-chrome-stable \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Layer cache: dependency install only re-runs when package*.json changes.
COPY package*.json ./
RUN npm ci --omit=dev

# App source
COPY src ./src
COPY scripts ./scripts

# Persistent browser profile dir — mounted from a host volume at runtime
# (./volumes/profiles in docker-compose.yml). The mkdir is here so the path
# exists even without the mount.
RUN mkdir -p /app/profiles && chown -R pwuser:pwuser /app
USER pwuser

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "src/server.js"]
