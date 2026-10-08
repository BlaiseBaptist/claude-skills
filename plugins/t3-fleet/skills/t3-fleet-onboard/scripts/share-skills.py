#!/usr/bin/env python3
"""Expose enabled blaise-skills plugin files to Codex without copying skills."""

import json
import os
from pathlib import Path
import tempfile


def replace_symlink(path, target):
    temporary = path.with_name(path.name + ".new-" + str(os.getpid()))
    try:
        temporary.symlink_to(target, target_is_directory=True)
        os.replace(temporary, path)
    finally:
        if temporary.is_symlink():
            temporary.unlink()


def sync(home):
    registry = json.loads((home / ".claude/plugins/installed_plugins.json").read_text())
    settings_path = home / ".claude/settings.json"
    enabled = json.loads(settings_path.read_text()).get("enabledPlugins", {}) if settings_path.exists() else {}
    links_dir = home / ".agents/skills"
    state_path = home / ".local/state/blaise-skills/shared-links.json"
    previous = json.loads(state_path.read_text()) if state_path.exists() else {}
    desired = {}
    runner = None
    for plugin, installs in registry["plugins"].items():
        if not plugin.endswith("@blaise-skills") or enabled.get(plugin) is False:
            continue
        install = next((entry for entry in installs if entry["scope"] == "user"), None)
        if install is None:
            continue
        root = Path(install["installPath"]).resolve()
        for manifest in sorted((root / "skills").glob("*/SKILL.md")):
            name = manifest.parent.name
            if name in desired:
                raise RuntimeError("Duplicate shared skill name: " + name)
            desired[name] = str(manifest.parent)
        if plugin == "t3-fleet@blaise-skills":
            runner = root / "skills/t3-fleet-onboard/scripts/claude-skills-sync.sh"
    # Check every collision before changing anything. Preserve unrelated skills.
    for name, target in desired.items():
        path = links_dir / name
        if path.exists() or path.is_symlink():
            owned = path.is_symlink() and os.readlink(path) == previous.get(name)
            already_matches = path.is_symlink() and os.readlink(path) == target
            if not owned and not already_matches:
                raise RuntimeError("Shared skill conflicts with an unmanaged path: " + str(path))
    links_dir.mkdir(parents=True, exist_ok=True)
    for name, target in desired.items():
        replace_symlink(links_dir / name, target)
    for name, target in previous.items():
        # Only remove a link still owned by this sync; never a user's replacement.
        path = links_dir / name
        if name not in desired and path.is_symlink() and os.readlink(path) == target:
            path.unlink()
    state_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", dir=state_path.parent, delete=False) as f:
        json.dump(desired, f, indent=2)
        temporary_state = Path(f.name)
    os.replace(temporary_state, state_path)
    # Keep the existing stable timer entrypoint current on future plugin updates.
    # Atomic replacement leaves the already-running shell's file intact.
    if runner is not None and runner.is_file():
        destination = home / ".local/bin/claude-skills-sync"
        destination.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as f:
            f.write(runner.read_bytes())
            temporary_runner = Path(f.name)
        temporary_runner.chmod(0o755)
        os.replace(temporary_runner, destination)
    return desired


if __name__ == "__main__":
    shared = sync(Path.home())
    print("Shared with Claude and Codex: " + ", ".join(sorted(shared)))
