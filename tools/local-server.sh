#!/bin/sh
# npm run local:start — Caddy plus the stand-in server (settings in .env.server), at
# https://ai-cruises.localhost:8443. Ctrl-C stops both. See CLAUDE.md, "Local HTTPS".
caddy start --config tools/Caddyfile.local --adapter caddyfile || exit 1
trap 'caddy stop' EXIT INT TERM
node --env-file=.env.server server.js
