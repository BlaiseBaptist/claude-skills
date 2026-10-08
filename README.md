# claude-skills

Blaise's shared Claude Code and Codex skills, published as a plugin marketplace
named `blaise-skills` and installed on the T3 Code fleet.

## Install

```sh
claude plugin marketplace add https://github.com/BlaiseBaptist/claude-skills.git
claude plugin install t3-fleet@blaise-skills --scope user
```

Use the HTTPS URL. The `owner/repo` shorthand clones over SSH, and the fleet
boxes have no GitHub SSH key. Both commands are idempotent.

## Plugins

| Plugin     | Skills                                          | Install on          |
| ---------- | ----------------------------------------------- | ------------------- |
| `t3-fleet` | `t3-fleet-onboard`, `t3-fleet-delegate`           | every box         |
| `desktop`  | `screenshot`                                    | boxes with a display |

Plugin skills are namespaced: `/t3-fleet:t3-fleet-onboard`, not `/t3-fleet-onboard`.
Use `/t3-fleet:t3-fleet-delegate` for cross-machine or cross-model T3 agents.
In Codex, invoke `$t3-fleet-delegate` or `$t3-fleet-onboard`.

## Layout

```
.claude-plugin/marketplace.json    catalog
plugins/<plugin>/
  .claude-plugin/plugin.json       manifest
  skills/<skill>/SKILL.md          skill, with its own scripts/ and references/
```

Inside a SKILL.md, resolve helpers relative to the directory containing that
loaded skill. Both harnesses supply its absolute path. Shell examples use
`SKILL_DIR` for that directory; do not depend on Claude-specific variable
expansion or tool names for a shared workflow.

## One installed set for both harnesses

Claude loads the versioned plugin files normally. The existing sync links each
enabled, user-installed `blaise-skills` skill into `~/.agents/skills` for
Codex. Both harnesses read the same `SKILL.md`, scripts, and references; there
is no second authored copy. Links advance to the actual installed plugin
version after each update. Desktop skills are shared only on boxes where that
plugin is installed and enabled.

The sync owns only links recorded in
`~/.local/state/blaise-skills/shared-links.json`. It preserves unrelated skills,
reports name collisions, and removes its own links when a plugin is disabled
or uninstalled. Claude's other marketplaces and box-local skills remain
independent. Do not duplicate these shared skills under `~/.claude/skills`,
which would make Claude load them twice.

Deploy `plugins/t3-fleet/skills/t3-fleet-onboard/scripts/claude-skills-sync.sh`
to the existing `~/.local/bin/claude-skills-sync` once to bootstrap the bridge.
Afterwards the sync refreshes that stable executable from the updated plugin
automatically. It requires Python 3 and Claude Code; Codex need not be running.
New sessions load the new skills. Restart an existing agent if discovery is
stale; no T3 server restart is needed.

## Versioning

No `version` field in any `plugin.json`, so each plugin's version resolves to
this repo's commit SHA and every push reaches the fleet on the next sync. Add a
`version` to a `plugin.json` to hold boxes still until you bump it.

Sync runs hourly from a systemd user timer on Linux (`claude-skills-sync.timer`)
or the existing launchd job on the Macs;
see the `t3-fleet-onboard` skill. Claude Code's own background auto-update fires
after a random delay of up to ten minutes, and T3-launched turns are usually
shorter than that, so it misses most of them.

Validate link ownership and update behavior with
`python3 -m unittest discover -s tests`.
