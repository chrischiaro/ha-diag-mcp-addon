#!/usr/bin/with-contenv bashio
set -euo pipefail

LOG_LEVEL="$(bashio::config 'log_level')"
ALLOW_ORIGIN="$(bashio::config 'allow_origin')"

export LOG_LEVEL
export ALLOW_ORIGIN

bashio::log.info "Starting HA Diagnostics MCP v$(bashio::addon.version) (log_level=${LOG_LEVEL})"

bashio::log.info "Dist listing:"
ls -al /app/server/dist || true

bashio::log.info "toolkit.js tail -c 800 /app/server/dist/toolkit.js" || true

bashio::log.info "toolkit.js mcp.tool call lines:"
grep -n "mcp.tool" /app/server/dist/toolkit.js || true

node /app/server/dist/index.js