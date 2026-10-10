#!/usr/bin/with-contenv bashio
set -euo pipefail

LOG_LEVEL="$(bashio::config 'log_level')"
HA_DIAG_ADDON_URL="$(bashio::config 'ha_diag_addon_url')"

# Optional options: unset means empty (server fails closed on auth, and allows no cross-origin access).
AUTH_TOKEN=""
if bashio::config.has_value 'auth_token'; then
  AUTH_TOKEN="$(bashio::config 'auth_token')"
fi
ALLOW_ORIGIN=""
if bashio::config.has_value 'allow_origin'; then
  ALLOW_ORIGIN="$(bashio::config 'allow_origin')"
fi

export LOG_LEVEL
export ALLOW_ORIGIN
export HA_DIAG_ADDON_URL
export AUTH_TOKEN

# Never log the token itself.
bashio::log.info "Starting HA Diagnostics MCP v$(bashio::addon.version) (log_level=${LOG_LEVEL}, addon_url=${HA_DIAG_ADDON_URL}, auth_token_set=$([ -n "${AUTH_TOKEN}" ] && echo yes || echo no))"

bashio::log.info "Dist listing:"
ls -al /app/server/dist || true

node /app/server/dist/index.js
