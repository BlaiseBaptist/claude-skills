#!/bin/sh
# Pull blaise-skills, update enabled plugins, and expose their same files to
# Codex. Deliberately lives outside the plugin cache: ${CLAUDE_PLUGIN_ROOT}
# is versioned and moves on every update, so a unit pointing into it would
# break the first time it worked.
set -e
# systemd hands a unit PATH=/usr/local/bin:/usr/bin, and launchd on macOS is
# no better. claude may be under ~/.local/bin (npm install, the Air) or under
# /opt/homebrew/bin (cask, blaises-mini), and some boxes (littlearch, both
# Macs) have no system node at all, only the Node 24 that onboarding step 1
# installs. Reach for all three; the missing ones cost nothing.
export PATH="$HOME/.local/bin:$HOME/.local/share/t3-node/bin:/opt/homebrew/bin:$PATH"

claude plugin marketplace update blaise-skills

python3 - <<'PY'
import json
from pathlib import Path
import subprocess
import sys

plugins = json.loads(subprocess.check_output(["claude", "plugin", "list", "--json"]))
for plugin in plugins:
    if plugin["id"].endswith("@blaise-skills"):
        # No --yes: older Claude versions reject it for these git sources.
        subprocess.run(["claude", "plugin", "update", plugin["id"]], check=True)

registry = json.loads((Path.home() / ".claude/plugins/installed_plugins.json").read_text())
fleet = next((entry for entry in registry["plugins"].get("t3-fleet@blaise-skills", []) if entry["scope"] == "user"), None)
root = Path(fleet["installPath"]) if fleet else Path.home() / ".claude/plugins/marketplaces/blaise-skills/plugins/t3-fleet"
helper = root / "skills/t3-fleet-onboard/scripts/share-skills.py"
subprocess.run([sys.executable, str(helper)], check=True)
PY
