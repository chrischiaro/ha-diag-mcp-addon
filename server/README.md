# Installation

1. Copy `scripts.yaml` -> `/config/scripts.yaml`

2. Make update to `configuration.yaml`:

- Ensure or add line: `script: !include scripts.yaml`
- Add:

```yaml
input_text:
  ha_diag_query:
  ha_diag_domains:
  ha_diag_entity_id:
  ha_diag_domain:

input_number:
  ha_diag_limit:
    min: 1
    max: 500
    step: 1

template:
  - trigger:
      - platform: event
        event_type: ha_diag_result
    sensor:
      - name: HA Diag Last Result
        unique_id: ha_diag_last_result
        state: "{{ (trigger.event.data.title or 'HA Diag') }}"
        attributes:
          full_text: "{{ trigger.event.data.text }}"
          formatted: >-
            {% set title = trigger.event.data.title or 'HA Diag' %}
            {% set t = (trigger.event.data.text or '') | string %}
            {% set obj = t | from_json(default=None) %}
            {% if obj is mapping %}
            **{{ title }}**

            {% if obj.error is defined %}
            - **Error:** {{ obj.error }}
            {% endif %}

            {% if obj.entity_id is defined %}
            - **Entity:** `{{ obj.entity_id }}`
            {% endif %}

            {% if obj.state is defined and obj.state is mapping %}
            - **State:** `{{ obj.state }}`
            {% endif %}

            {% if obj.results is defined and obj.results is iterable %}
            - **Results:** {{ obj.results | length }}
            {% for r in obj.results[:20] %}
              - `{{ r.entity_id }}` — {{ (r.name if r.name is defined else '') }} ({{ (r.state if r.state is defined else '') }})
            {% endfor %}
            {% endif %}
            {% else %}
            **{{ title }}**
            ```text
            {{ t }}
            ```
            {% endif %}
          ts: "{{ now().isoformat() }}"

python_script:
```

3. Create helpers (**Settings** > **Devices & services** > **Helpers** > **Create Helper** (button)):

- Create 4 text helpers named as follows:
  - `ha_diag_query`
  - `ha_diag_domains`
  - `ha_diag_entity_id`
  - `ha_diag_domain`

- Create 1 number helper with the following property values:
  - Name: `ha_diag_limit`
  - min: 1
  - max: 500
  - step: 1

4. Create dashboard with the YAML in `ha-diagnostics.yaml`.
