# claude-skills

Blaise's Claude Code skills, published as a plugin marketplace named
`blaise-skills` and installed on every T3 Code fleet box.

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

## Layout

```
.claude-plugin/marketplace.json    catalog
plugins/<plugin>/
  .claude-plugin/plugin.json       manifest
  skills/<skill>/SKILL.md          skill, with its own scripts/ and references/
```

Inside a SKILL.md, refer to files shipped alongside it with
`${CLAUDE_PLUGIN_ROOT}/skills/<skill>/...`, which Claude Code expands to an
absolute path. Never hardcode `~/.claude/skills/...`; that directory holds
box-local skills now.

## Versioning

No `version` field in any `plugin.json`, so each plugin's version resolves to
this repo's commit SHA and every push reaches the fleet on the next sync. Add a
`version` to a `plugin.json` to hold boxes still until you bump it.

Sync runs from a systemd user timer on each box (`claude-skills-sync.timer`);
see the `t3-fleet-onboard` skill. Claude Code's own background auto-update fires
after a random delay of up to ten minutes, and T3-launched turns are usually
shorter than that, so it misses most of them.
