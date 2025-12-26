# No imports allowed in python_script

services = hass.services.services  # domain -> dict of service_name -> description

out = {}
for domain, svc_map in services.items():
    out[domain] = sorted(list(svc_map.keys()))

hass.bus.fire(
    "ha_diag_result",
    {
        "title": "HA Diag: List services",
        "text": out,  # <-- send dict; let templates do tojson if needed
    },
)