#!/bin/bash
# fetch-drive-config-v2.sh - v2 config loader support
# This script updates the NanoClaw fetch process to support v2 agent config

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON="${PYTHON:-python3}"

echo "[v2-loader] Starting v2 config loader..."
echo "[v2-loader] Script directory: ${SCRIPT_DIR}"

# Check if v2 config exists in group
if [ -f "/workspace/group/.claude/config.md" ]; then
    echo "[v2-loader] ✓ Found .claude/config.md"

    # Parse v2 config to extract parameters.
    # config.md is markdown with a fenced ```yaml block, so grep/awk is fragile.
    IFS='|' read -r CONFIG_VERSION CONTEXT_ROOT_ID AGENT_FOLDER_ID AGENT_SLUG < <(
        "$PYTHON" - <<'PY'
import re
import yaml
from pathlib import Path

p = Path('/workspace/group/.claude/config.md')
text = p.read_text(encoding='utf-8', errors='replace')

# Extract first ```yaml ... ``` fenced block; fallback to whole file.
yaml_block = None
if '```yaml' in text:
    start = text.find('```yaml')
    after = text.find('\n', start)
    end = text.find('```', after + 1)
    if after != -1 and end != -1:
        yaml_block = text[after+1:end]

if yaml_block is None:
    yaml_block = text

data = yaml.safe_load(yaml_block) or {}

drive = data.get('drive') if isinstance(data.get('drive'), dict) else {}

config_version = str(data.get('config_version', '')).strip()
context_root_id = str(drive.get('context_root_id', '')).strip()
agent_folder_id = str(drive.get('agent_folder_id', '')).strip()

# Try to derive agent slug from the markdown heading, e.g. "# Marcus — Agent Configuration"
slug = 'agent'
for line in text.splitlines():
    m = re.match(r'^#\s+([^—-]+)', line.strip())
    if m:
        slug = m.group(1).strip().lower()
        slug = re.sub(r'[^a-z0-9]+', '-', slug).strip('-')
        break

print(f"{config_version}|{context_root_id}|{agent_folder_id}|{slug}")
PY
    )
    IFS=$' \t\n'

    echo "[v2-loader] Detected config_version=${CONFIG_VERSION}"
    echo "[v2-loader] context_root_id=${CONTEXT_ROOT_ID:-}" 
    echo "[v2-loader] agent_folder_id=${AGENT_FOLDER_ID}"
    echo "[v2-loader] agent_slug=${AGENT_SLUG}"

    if [ "$CONFIG_VERSION" = "2" ]; then
        echo "[v2-loader] ✓ Using v2 parameters"

        # Call drive-fetch.py with v2 parameters
        echo "[v2-loader] Calling drive-fetch.py with v2 config..."

        "$PYTHON" /opt/nanoclaw/scripts/lib/drive-fetch.py \
            --agent-folder-id "$AGENT_FOLDER_ID" \
            --rules-shared-id "$CONTEXT_ROOT_ID" \
            --target-dir "/workspace/group" \
            --soul-out "/workspace/group/${AGENT_SLUG}-soul.md" \
            --claude-md-out "/workspace/group/.claude/CLAUDE.md" \
            --sa-key-path "/opt/nanoclaw/service-accounts/google-chat-sa.json"

        # Check if tools-inventory.json was generated
        if [ -f "/workspace/group/.claude/tools-inventory.json" ]; then
            echo "[v2-loader] ✓ tools-inventory.json created"
            echo "[v2-loader] Contents:"
            cat "/workspace/group/.claude/tools-inventory.json"
            exit 0
        else
            echo "[v2-loader] ERROR: tools-inventory.json not created"
            exit 2
        fi
    else
        echo "[v2-loader] Config version is not 2, skipping v2 loader"
    fi
fi

# Fall back to v1 behavior if no config.md (or config_version != 2)
echo "[v2-loader] No v2 config found, falling back to v1 behavior..."

# Call original fetch-drive-config.sh if it exists
if [ -f "${SCRIPT_DIR}/fetch-drive-config.sh" ]; then
    echo "[v2-loader] Calling original v1 fetch script..."
    bash "${SCRIPT_DIR}/fetch-drive-config.sh"
else
    echo "[v2-loader] ERROR: Original fetch-drive-config.sh not found at ${SCRIPT_DIR}"
    exit 1
fi

