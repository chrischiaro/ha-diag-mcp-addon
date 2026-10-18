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

RO_TOKEN=""
if bashio::config.has_value 'read_only_token'; then
  RO_TOKEN="$(bashio::config 'read_only_token')"
fi
RO_EXTRA_PATHS=""
if bashio::config.has_value 'read_only_extra_paths'; then
  RO_EXTRA_PATHS="$(bashio::config 'read_only_extra_paths')"
fi

export LOG_LEVEL
export ALLOW_ORIGIN
export HA_DIAG_ADDON_URL
export AUTH_TOKEN

# Never log the token itself.
bashio::log.info "Starting HA Diagnostics MCP v$(bashio::addon.version) (log_level=${LOG_LEVEL}, addon_url=${HA_DIAG_ADDON_URL}, auth_token_set=$([ -n "${AUTH_TOKEN}" ] && echo yes || echo no))"

bashio::log.info "Dist listing:"
ls -al /app/server/dist || true

# Optional read-only instance on 3001 with its own token. It never gets the full-access token, and a read-only
# token equal to the full-access one would defeat the split, so refuse to start it in that case.
RO_PID=""
if [ -n "${RO_TOKEN}" ]; then
  if [ "${RO_TOKEN}" = "${AUTH_TOKEN}" ]; then
    bashio::log.error "read_only_token must differ from auth_token; read-only instance NOT started."
  else
    bashio::log.info "Starting read-only instance on :3001"
    PORT=3001 READ_ONLY=true AUTH_TOKEN="${RO_TOKEN}" HA_DIAG_AUTH_TOKEN="${RO_TOKEN}" \
      READ_ONLY_EXTRA_PATHS="${RO_EXTRA_PATHS}" node /app/server/dist/index.js &
    RO_PID=$!
  fi
fi

node /app/server/dist/index.js &
MAIN_PID=$!

# If either server exits, stop the add-on so the Supervisor restarts it and the failure is visible.
wait -n
status=$?
bashio::log.error "A server process exited (status ${status}); stopping add-on."
kill "${MAIN_PID}" ${RO_PID:+"${RO_PID}"} 2>/dev/null || true
exit "${status}"
