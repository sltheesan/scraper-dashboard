# Microsoft's Playwright image ships with all browser deps preinstalled.
# Pin to the version that matches `playwright` in package.json.
FROM mcr.microsoft.com/playwright:v1.60.0-jammy

# Install:
#  - Google Chrome stable (for channel:'chrome')
#  - Xvfb        : virtual X display so headed Chrome can run on a headless VPS
#  - fluxbox     : tiny window manager so the browser has a usable frame
#  - x11vnc      : VNC server attached to the Xvfb display
#  - novnc       : web-based VNC client (HTML/JS)
#  - websockify  : WebSocket→TCP proxy that bridges browser ↔ x11vnc
#  - supervisor  : single foreground process to manage all of the above + Node
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      wget gnupg ca-certificates \
      xvfb x11vnc fluxbox novnc websockify supervisor \
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

# Process orchestrator config
COPY docker/supervisord.conf /etc/supervisor/conf.d/supervisord.conf

# Persistent browser profile dir — mounted from a host volume at runtime.
RUN mkdir -p /app/profiles \
 && chown -R pwuser:pwuser /app \
 && mkdir -p /var/log/supervisor /tmp/.X11-unix \
 && chmod 1777 /tmp/.X11-unix

# supervisord runs as root so it can spawn children as pwuser.
ENV NODE_ENV=production
EXPOSE 3000 6080
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
