# HA Diagnostics MCP — External Access Setup

## Overview

The `ha-diag-mcp` addon runs inside Home Assistant as an HTTP MCP server on port 3000. This document describes how it was exposed externally via Cloudflare Tunnel, and how it was wired into Claude Code and OpenClaw.

---

## Architecture

```
Claude Code (Mac)          ─┐
OpenClaw (VM)              ─┼──► https://mcp.chiaro.us/mcp ──► Cloudflare Tunnel ──► HA addon (port 3000)
Any MCP client             ─┘
```

---

## 1. Cloudflare Setup

### Domain
- Domain: `chiaro.us` (utility domain, no website)
- Nameservers moved from Squarespace to Cloudflare (free account)
- Cloudflare automatically imported existing DNS records during migration

### DNSSEC (pending)
- DNSSEC was disabled at Squarespace to allow nameserver change
- To re-enable: Cloudflare dashboard → your domain → DNS → Settings → enable DNSSEC → copy DS record → add DS record at Squarespace registrar
- **Do this only after domain shows Active in Cloudflare**

### Tunnel
- Created via Cloudflare Zero Trust → Networks → Connectors → Add a tunnel
- Tunnel name: `chiaro_home_assistant`
- Connector type: Cloudflared

### Public Hostnames
| Subdomain | Service | Purpose |
|-----------|---------|---------|
| `ha.chiaro.us` | `http://homeassistant:8123` | HA main UI |
| `mcp.chiaro.us` | `http://homeassistant:3000` | HA Diagnostics MCP server |

---

## 2. Home Assistant Setup

### CloudFlared Addon
- Installed from: `https://github.com/brenner-tobias/ha-addons`
- Addon name: **CloudFlared** (by Tobias Brenner)
- Configuration (Settings → Apps → CloudFlared → Configuration → enable optional fields):
  - `external_hostname`: `ha.chiaro.us`
  - `tunnel_token`: *(token from Cloudflare tunnel dashboard)*

### Trusted Proxies (`/config/configuration.yaml`)
Required for HA to accept forwarded headers from Cloudflare Tunnel:

```yaml
http:
  use_x_forwarded_for: true
  trusted_proxies:
    - 127.0.0.1
    - 172.30.33.0/24  # HAOS Docker supervisor network
```

---

## 3. Claude Code (Mac)

MCP servers are configured in `~/.claude.json` (not `settings.json`).

Added via CLI:
```bash
claude mcp add --transport http --scope user ha-mcp-tunnel https://mcp.chiaro.us/mcp
```

> **Note:** The `settings.json` format (`"type": "http"`) does not work — must use `claude mcp add` CLI command which writes to `~/.claude.json`.

---

## 4. OpenClaw (VM)

MCP servers are configured in `~/.openclaw/openclaw.json` under the `mcp.servers` key:

```json
"mcp": {
  "servers": {
    "ha-mcp-tunnel": {
      "type": "http",
      "url": "https://mcp.chiaro.us/mcp"
    }
  }
}
```

After editing the config, restart the gateway:
```bash
systemctl --user restart openclaw-gateway
```

---

## 5. Verification

Test the MCP endpoint is reachable:
```bash
curl -s -X POST https://mcp.chiaro.us/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
```

Expected response:
```
event: message
data: {"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{"listChanged":true}},"serverInfo":{"name":"home-automation-diagnostics","version":"0.1.0"}},"jsonrpc":"2.0","id":1}
```

---

## Available MCP Tools

The addon exposes these tools to any connected AI client:

| Tool | Description |
|------|-------------|
| `diagnose_entity` | Diagnose a specific HA entity |
| `diagnose_automation` | Diagnose why an automation is failing |
| `ha_get_state` | Get current state of any entity |
| `ha_list_entities` | List entities, optionally filtered by domain |
| `ha_find_entities` | Search entities by name or entity_id |
| `ha_call_service` | Call any HA service |
| `ha_evaluate_template` | Evaluate a Jinja2 template against live state |
| `ha_read_file` | Read any file from `/config/` |
| `ha_find_file` | Find files by name in `/config/` |
| `ha_grep_file` | Search for a pattern within a config file |
| `ha_write_file` | Write/edit files in `/config/` |
| `ha_get_automation_config` | Get full automation configuration |
| `ha_list_repairs` | List active HA repairs/issues |
| `ha_list_services` | List available HA services |
| `supervisor_host_info` | Get HAOS system info |

---

## Notes

- The local `uvx ha-mcp` server (in `~/.claude/settings.json`) still exists and connects via local network IP. The tunnel (`ha-mcp-tunnel`) provides the same access remotely.
- Nabu Casa remote access (`ofq3wqd2uc9cgfkylisv8mm4jth8yali.ui.nabu.casa`) remains active but is now redundant for remote HA UI access — `ha.chiaro.us` serves the same purpose via Cloudflare Tunnel.
- The addon is published at: https://github.com/chrischiaro/ha-diag-mcp-addon
