#!/bin/sh
# Pull the blaise-skills marketplace and roll every installed plugin from it
# forward. Deliberately lives outside the plugin cache: ${CLAUDE_PLUGIN_ROOT}
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

claude plugin list --json | node -e '
  let s = "";
  process.stdin.on("data", d => s += d).on("end", () => {
    for (const p of JSON.parse(s)) {
      if (p.id.endsWith("@blaise-skills")) console.log(p.id);
    }
  });
' | while read -r plugin; do
  # No --yes: it only matters for marketplace-declared command sources, which
  # these plugins do not use, and claude 2.1.228 (littlearch) rejects the flag.
  claude plugin update "$plugin"
done
