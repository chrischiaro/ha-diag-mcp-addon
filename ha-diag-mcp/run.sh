#!/usr/bin/with-contenv bashio
set -euo pipefail

LOG_LEVEL="$(bashio::config 'log_level')"
ALLOW_ORIGIN="$(bashio::config 'allow_origin')"

export LOG_LEVEL
export ALLOW_ORIGIN

bashio::log.info "Starting HA Diagnostics MCP (log_level=${LOG_LEVEL})"
node /app/server/dist/index.js