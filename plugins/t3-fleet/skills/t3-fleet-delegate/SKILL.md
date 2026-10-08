---
name: t3-fleet-delegate
description: Delegate work to a real T3 Code thread on another fleet machine or with another provider, model, or reasoning setting, and retrieve its result. Use for Opus-to-Sol or Sol-to-Opus delegation across the fleet.
---

# Delegate to another T3 agent

Use the bundled helper to create a visible T3 conversation on the selected
machine. The destination's T3 server launches its provider with its own
authentication and configuration. No T3 source edits or server restarts are
needed. The helper currently supports **T3 0.0.45** and Python 3.

Set `SKILL_DIR` in your shell to the directory containing the loaded
`SKILL.md`, using the absolute skill path supplied by your harness. With the
shared sync, both agents can also use:

```sh
SKILL_DIR="$HOME/.agents/skills/t3-fleet-delegate"
```

Claude invokes this skill as `/t3-fleet:t3-fleet-delegate`; Codex invokes it as
`$t3-fleet:t3-fleet-delegate`. Both read the same files. The helper is
`$SKILL_DIR/scripts/t3-fleet-agent.py`. Use this bundled path so the helper follows plugin updates; the older
`~/.local/bin/t3-fleet-agent` convenience copy is not updated by skills sync.
No helper installation is needed on the destination: the script transmits its
worker through SSH and calls T3 on `127.0.0.1:3773` there.

## Select the destination and settings

Honor the user's machine, model, settings, and task scope. If a selection was
left open, choose a suitable one and state it. A request to delegate authorizes
that task; this skill does not authorize unrelated work or further delegation.

The active roster is `fleet.md` in `T3_code_improvements`; consult it when
available. Currently the helper allows `archlinux`, `war`, and `blaises-mini`.
Do not contact dormant or unlisted boxes. Check `tailscale status` before a
remote launch. Offline or failed batch SSH means report the failed destination;
do not restore T3 Connect or switch to another access path. The helper routes
over tailnet IPs while verifying the FQDN's SSH host key.

Get **target-local** registered workspace paths with:

```sh
python3 "$SKILL_DIR/scripts/t3-fleet-agent.py" archlinux projects
```

The workspace must already be a registered T3 project on that box. Linux
projects commonly use `/home/blaise/...`; the Mini uses `/Users/blaise/...`.
The helper does not copy files or synchronize checkouts. For concurrent edits,
prepare an isolated worktree on the target and pass `--worktree /absolute/path`.
It must belong to the selected project; the helper records its current branch.

Choose instance/model/option IDs from the destination's T3 picker or verified
existing selections. Common selections on the current fleet:

| Agent | Provider instance | Model | Effort option |
|---|---|---|---|
| Sol | `codex` | `gpt-6.1-sol` | `reasoningEffort` |
| Opus | `claudeAgent` | `claude-opus-5-5` | `effort` |

`--options` accepts a JSON object, for example
`'{"reasoningEffort":"high","serviceTier":"default"}'` for Sol or
`'{"effort":"high","fastMode":false}'` for Opus. Availability can differ
between boxes; do not guess an unsupported model or option.

Runtime defaults to `approval-required`; the child may need attention in T3.
Use `--runtime-mode auto-accept-edits` or `full-access` only when the task's
existing authorization permits it. `--interaction-mode plan` selects plan
mode; otherwise it is `default`. Do not widen permissions just to clear a
blocked child.

## Launch and retrieve the result

Supply a self-contained task on **stdin**: include relevant context, expected
deliverable, allowed changes, and any limits on further delegation. The child
does not receive the parent's conversation. For a review, include the actual
diff/design or identify the target-local files and revision to inspect.

For example, Opus can ask Sol on archlinux:

```sh
python3 "$SKILL_DIR/scripts/t3-fleet-agent.py" archlinux start \
  --cwd /home/blaise/T3_code_improvements \
  --provider codex --model gpt-6.1-sol \
  --options '{"reasoningEffort":"high"}' \
  --title 'Sol review for Opus' --request-id UNIQUE_TASK_ROUND_ID \
  --wait 45 <<'TASK'
Review the supplied change and return concrete findings. Do not modify files
or delegate further. Include the actual change and necessary context here.
TASK
```

For Sol asking Opus, use destination `blaises-mini`, the matching
`/Users/blaise/...` workspace, `--provider claudeAgent`,
`--model claude-opus-5-5`, and `--options '{"effort":"high","fastMode":false}'`.

Use a unique `--request-id` for each task/round and **reuse it on retries of
that same prompt and settings**. The helper prints the ID on stderr before
attempting the operation. It reuses the thread and first message, preventing
duplicate launches. A fresh review round needs a fresh ID and brief.

Keep the returned **machine and threadId**. JSON includes selected settings,
turn state, session status, errors, messages, and `waitTimedOut`. Launch without
`--wait` for background work, or wait up to 50 seconds. A timed-out wait leaves
the child running; do not start another copy.

```sh
python3 "$SKILL_DIR/scripts/t3-fleet-agent.py" archlinux wait THREAD_UUID --wait 45
python3 "$SKILL_DIR/scripts/t3-fleet-agent.py" archlinux read THREAD_UUID
```

`completed` is the persisted turn's completion state. Read its actual answer
before reporting success. `error` or `lastError` needs investigation;
`interrupted` is not successful completion. Check in bounded waits when useful;
retain IDs and tell the user when work remains running or needs input.

Use `interrupt THREAD_UUID` when cancellation is requested. Use
`archive THREAD_UUID` to put away finished threads and `unarchive THREAD_UUID`
to restore them; archived threads must be restored before reading through this
API. Archive preserves the conversation.

## Visibility and credentials

These are ordinary T3 sidebar threads, without automatic cross-server
parent-child grouping or notifications. Track the relationship in the title
and retained IDs; the parent retrieves results with read/wait. Do not claim
automatic callback delivery or that child code changes reached the parent's
checkout. A shell-launched `codex exec` or `claude -p` is not this workflow:
it would bypass T3 thread ownership and visibility.

The helper uses existing SSH access as Blaise and a two-minute local T3 bearer,
revoked after each command. T3 0.0.45 issues its standard broad CLI scopes;
this is not a narrowly scoped service account. Never print or store the bearer,
inspect T3's secrets directory, or enable shell tracing around credentials.
If the helper rejects a newer T3 version, check that version's API and update
the skill helper; do not remove the guard as a workaround.
