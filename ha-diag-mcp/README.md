# HA Diagnostics MCP

## ha-diag-mcp

Diagnostic MCP server for Home Assistant.

- `server/` – TypeScript MCP server (Streamable HTTP)
- `addon/`  – Home Assistant add-on wrapper for HAOS

Endpoint (after installing add-on):

- http://HOME_ASSISTANT_IP:3000/health
- http://HOME_ASSISTANT_IP:3000/mcp

## Authentication

Every route except `/` and `/health` (including `/mcp`, `/fs/*` and `/yaml/*`) requires
`Authorization: Bearer <token>`.

1. Generate a long random token, e.g. `openssl rand -hex 32`. Use at least 32 characters with no whitespace:
   a shorter token works but logs a warning, and one containing whitespace is rejected (every protected
   route answers `503` and the add-on log says why).
2. Set it as the add-on option **`auth_token`** and restart the add-on.
3. Give the same value to each client:
   - `stdio-http-proxy`: set the `HA_DIAG_AUTH_TOKEN` environment variable (never put the token on the
     command line or in a config file you commit).
   - Any other MCP client: send the `Authorization: Bearer ...` header.

If `auth_token` is not set the server still starts, but answers `503` on every protected route
(it never falls back to open access). Failed attempts are logged (method, path, client address; never
the token). Tokens are compared in constant time.

## CORS

`allow_origin` is a comma-separated list of exact browser origins that may call the server cross-origin
(e.g. `https://dashboard.example.com`). Empty (the default) grants no cross-origin access. A wildcard
(`*`) is ignored, and the add-on log says so at startup. Non-browser clients (the stdio proxy, curl) are
not affected by CORS.

The tools that read and write files call this server's own `/fs/*` endpoints over loopback
(`127.0.0.1`), so the token never leaves the add-on. The `ha_diag_addon_url` option is no longer used for that.

The server speaks plain HTTP. Treat the token like a password and keep the port on a trusted network.
