#!/bin/sh
# Pull the blaise-skills marketplace and roll every installed plugin from it
# forward. Deliberately lives outside the plugin cache: ${CLAUDE_PLUGIN_ROOT}
# is versioned and moves on every update, so a unit pointing into it would
# break the first time it worked.
set -e
export PATH="$HOME/.local/bin:$PATH"

claude plugin marketplace update blaise-skills

claude plugin list --json | node -e '
  let s = "";
  process.stdin.on("data", d => s += d).on("end", () => {
    for (const p of JSON.parse(s)) {
      if (p.id.endsWith("@blaise-skills")) console.log(p.id);
    }
  });
' | while read -r plugin; do
  claude plugin update "$plugin" --yes
done
