# New MCP Tools Implementation Summary

## Overview

Added 5 new tools to enable full autonomous debugging capability for the ha-mcp server. These tools address the gaps identified during previous troubleshooting sessions.

## Tools Implemented

### 1. `ha_read_file`

**Purpose**: Read any file from the Home Assistant /config filesystem

**Parameters**:

- `path` (string, required): Full path to the file (must be within /config/)
- `max_size` (number, optional): Maximum file size in bytes (default: 100000)

**Use Cases**:

- Check actual content of package files
- Read automations.yaml
- Inspect .storage files
- Verify configuration files

**Security**: Restricts access to /config/ directory only

---

### 2. `ha_find_file`

**Purpose**: Find files by name within the Home Assistant /config directory

**Parameters**:

- `filename` (string, required): Filename or pattern to search for
- `search_root` (string, optional): Root directory to search from (default: /config)

**Use Cases**:

- Locate automations.yaml
- Find package files
- Discover configuration files
- Search for specific YAML files

**Features**:

- Recursive search (max depth: 5)
- Max 50 results
- Skips hidden directories

---

### 3. `ha_grep_file`

**Purpose**: Search for a pattern within a file and return matching lines with context

**Parameters**:

- `path` (string, required): Full path to the file (must be within /config/)
- `pattern` (string, required): Search pattern (regex supported)
- `context_lines` (number, optional): Number of context lines before/after match (default: 5)

**Use Cases**:

- Find specific configurations or patterns in files
- Equivalent to `grep -A 5 -B 5 pattern file`
- Debug configuration issues

**Features**:

- Case-insensitive regex matching
- Context lines with line numbers
- Max 20 matches per query
- Highlights matching lines

---

### 4. `ha_call_service`

**Purpose**: Call any Home Assistant service directly

**Parameters**:

- `domain` (string, required): Service domain (e.g., 'automation', 'homeassistant', 'light')
- `service` (string, required): Service name (e.g., 'trigger', 'reload', 'turn_on')
- `service_data` (object, optional): Service data/parameters
- `target` (object, optional): Target entities, devices, or areas

**Use Cases**:

- Trigger automations for testing (`automation.trigger`)
- Reload configurations (`automation.reload`, `homeassistant.reload_all`)
- Control devices (`light.turn_on`, `switch.toggle`)
- Execute any HA service

**Features**:

- Returns success/failure status
- Includes error messages on failure
- Supports entity, device, and area targeting

---

### 5. `ha_evaluate_template`

**Purpose**: Evaluate a Jinja2 template against the live Home Assistant state

**Parameters**:

- `template` (string, required): Jinja2 template to evaluate

**Use Cases**:

- Test condition logic (`{{ states('sensor.temperature') > 20 }}`)
- Debug template syntax
- Check state values
- Equivalent to Developer Tools → Template

**Features**:

- Live state evaluation
- Returns rendered result
- Includes error messages for invalid templates

---

## Backend Changes

### ha.ts

**Added functions**:

- `haPost(path, body)`: HTTP POST requests to HA API
- `haCallService(domain, service, serviceData, target)`: Service call wrapper
- `haRenderTemplate(template)`: Template rendering wrapper

### index.ts

**Added HTTP endpoints**:

- `POST /fs/read`: File reading endpoint with security restrictions
- `POST /fs/find`: File finding endpoint with recursive search
- `POST /fs/grep`: Pattern matching endpoint with context

**Security Features**:

- All filesystem operations restricted to /config/ directory
- File size limits to prevent memory issues
- Result limits to prevent overwhelming responses

### mcpTools.ts

**Registered 5 new MCP tools** that communicate with the addon endpoints

### run.sh

**Added environment variable export**:

- `HA_DIAG_ADDON_URL`: Enables tools to communicate with addon HTTP endpoints

---

## Deployment Steps

### 1. Build the addon

```bash
cd ~/dev/mcps/ha-diag-mcp-addon/ha-diag-mcp/server
npm run build
```

### 2. Build Docker image

```bash
cd ~/dev/mcps/ha-diag-mcp-addon/ha-diag-mcp
docker build -t chrischiaro/ha-diag-mcp-addon-amd64:latest .
```

### 3. Push to registry (if using Docker Hub)

```bash
docker push chrischiaro/ha-diag-mcp-addon-amd64:latest
```

### 4. Update version in config.yaml

Edit `config.yaml` and increment version (e.g., 0.1.19 → 0.1.20)

### 5. Reinstall addon in Home Assistant

- Go to Settings → Add-ons
- Find "Home Automation Diagnostics MCP"
- Click Update (or uninstall and reinstall if needed)

### 6. Configure addon

Ensure `ha_diag_addon_url` is set in addon configuration:

```yaml
ha_diag_addon_url: "http://homeassistant:3000"
```

### 7. Restart addon

After configuration, restart the addon to apply changes

---

## Testing

### Test file operations

```javascript
// Find automations.yaml
await ha_find_file({ filename: "automations.yaml" })

// Read a file
await ha_read_file({ path: "/config/automations.yaml" })

// Search for a pattern
await ha_grep_file({
  path: "/config/automations.yaml",
  pattern: "automation_name",
  context_lines: 5
})
```

### Test service calls

```javascript
// Trigger an automation
await ha_call_service({
  domain: "automation",
  service: "trigger",
  target: { entity_id: "automation.test_automation" }
})

// Reload automations
await ha_call_service({
  domain: "automation",
  service: "reload"
})
```

### Test template evaluation

```javascript
// Check sensor state
await ha_evaluate_template({
  template: "{{ states('sensor.temperature') }}"
})

// Test condition
await ha_evaluate_template({
  template: "{{ states('sensor.temperature') | float > 20 }}"
})
```

---

## Impact

### Before

- AI had to ask user to run `grep`, `find`, `cat` commands manually
- Could not trigger automations or reload configs
- Could not test template conditions
- Required back-and-forth for every file operation

### After

- AI can autonomously read, search, and find files
- AI can trigger automations and reload configs for testing
- AI can evaluate templates to diagnose condition logic
- Complete autonomous debugging workflow possible

---

## Future Enhancements

### Potential additions

1. File writing capabilities (with safety checks)
2. Backup/restore functionality
3. Log file access (/config/home-assistant.log)
4. Entity history visualization
5. Performance metrics collection

---

## Security Considerations

### Current safeguards

- All file operations restricted to /config/ directory
- File size limits prevent memory exhaustion
- Result limits prevent overwhelming responses
- Path normalization prevents directory traversal
- No file write/delete capabilities (read-only for safety)

### Recommended

- Enable audit logging for all tool calls
- Set up rate limiting for file operations
- Monitor addon resource usage
- Regular security reviews of filesystem access patterns
