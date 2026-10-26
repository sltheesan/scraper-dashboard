# Scraper Dashboard — app container.
#
# Single container that runs the Node app AND an in-container virtual desktop
# (Xvfb + fluxbox + x11vnc + noVNC) so the *headed* manual-login flow works on a
# headless server. supervisord orchestrates all processes (see
# docker/supervisord.conf). MongoDB is NOT here — it runs natively on the VPS and
# the app reaches it via `network_mode: host` at 127.0.0.1:27017.

# Playwright's image already ships Chromium + all browser OS dependencies on
# Ubuntu Noble (24.04), matching the app's playwright ^1.60.
FROM mcr.microsoft.com/playwright:v1.60.0-noble

USER root

# Virtual desktop + VNC bridge + process supervisor.
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb fluxbox x11vnc websockify novnc supervisor \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /var/log/supervisor

WORKDIR /app

# Install production deps first for better layer caching.
COPY package*.json ./
RUN npm ci --omit=dev

# Install real Google Chrome (the app uses BROWSER_CHANNEL=chrome, less
# detectable than chromium-headless-shell).
RUN npx playwright install chrome

# App source.
COPY . .

# Make noVNC open straight into the viewer. (node is already at /usr/bin/node in
# the Playwright image, which is what supervisord invokes.)
RUN ln -sf /usr/share/novnc/vnc.html /usr/share/novnc/index.html

# The runtime user shipped by the Playwright image is `pwuser` (uid 1000); the
# app + browsers run as it. supervisord itself starts as root (it drops to
# pwuser per-program). /app must be owned by pwuser so it can write.
RUN chown -R pwuser:pwuser /app

# Dashboard (3000) and noVNC (6080). With network_mode: host these bind directly
# on the host; UFW keeps them off the public internet (reach via SSH tunnel).
EXPOSE 3000 6080

CMD ["/usr/bin/supervisord", "-c", "/app/docker/supervisord.conf"]
