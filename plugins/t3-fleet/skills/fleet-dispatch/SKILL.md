---
name: fleet-dispatch
description: Use when dispatching, checking, or interrupting work on another T3 Code fleet box (archlinux, littlearch, bigarch) over the tailnet.
---

# fleet-dispatch

Dispatches work to an already-onboarded T3 Code fleet box and reads results
back, over the tailnet HTTPS API (`https://<host>.tail2b35ba.ts.net`). This is
a plain CLI script invoked via Bash, deliberately not an MCP server (script →
skill → MCP only if a concrete wall is hit).

## Prerequisites

- Node.js on PATH (any recent Node with global `fetch`/`crypto.randomUUID`,
  so v18+; this machine's system `node` at `/usr/bin/node` works, no need for
  the t3-pinned Node under `~/.local/share/t3-node`).
- The target host has already been onboarded (`t3-fleet-onboard`) and has an
  entry in the config file below.

## Config

`~/.config/fleet/hosts.json` (override with `$FLEET_CONFIG`), mode 0600:

```json
{
  "archlinux": { "baseUrl": "https://archlinux.tail2b35ba.ts.net", "bearer": "<token>" },
  "bigarch":   { "baseUrl": "https://bigarch.tail2b35ba.ts.net",   "bearer": "<token>" }
}
```

The script creates this file (empty `{}`, mode 0600) if it's missing, and
re-tightens the mode if it finds it looser than 0600. It never prints a
bearer to stdout/stderr. `t3-fleet-onboard` is what actually populates a
host's entry (it mints the bearer over SSH on the target box and writes it
here directly, so the token never appears in a transcript).

## Usage

All commands: `node ${CLAUDE_PLUGIN_ROOT}/skills/fleet-dispatch/scripts/fleet.mjs <subcommand> ...`

```
prompt <host> <project> <text> [--model NAME] [--timeout SECONDS]
    thread.create + thread.turn.start, then poll to completion.
    Prints the threadId, final turn state, and the assistant message text.
    <project> may be a projectId (UUID) or a project title (e.g. "Archlinux Main").
    Title matching is case-sensitive and titles follow each box's own
    casing convention, not a fixed "Hostname Main" pattern. For example,
    littlearch's project is titled `littlearch Main` (lowercase), not `Littlearch Main`.
    Guessing wrong fails fast with the list of known projects on that host, so
    when in doubt run `list <host>` first rather than guessing the casing.
    Default model: the project's defaultModelSelection, or claude-sonnet-5 if
    the project has none. Default timeout: 300s.

result <host> <threadId> [--timeout SECONDS]
    Poll (or read, if already done) a thread and print its outcome the same
    way `prompt` does. Use this to check on / resume-watching a thread you
    (or something else) started earlier.

list <host>
    GET /api/orchestration/snapshot -> prints projects[] and threads[]
    (id, title, workspaceRoot / latest turn state).

interrupt <host> <threadId>
    thread.turn.interrupt.

cleanup <host> <threadId>
    thread.delete. Always clean up threads you created for testing/probing.

approve <host> <threadId> <decision> [requestId]
    thread.approval.respond. decision is one of:
    accept | acceptForSession | decline | cancel.
    Deliberately a separate subcommand (never folded into prompt/result) so
    that auto-approving a remote agent's permission prompt is visible in the
    transcript, not implicit.
    requestId: the wire schema needs this field (NOT documented in the
    original design doc's tool table, which only listed
    `remote_approve(host, threadId, decision)`; discovered by probing, since
    a bare {threadId, decision} body 400s). If omitted, the script tries to
    find a pending approval's requestId inside the thread's activity log;
    if it can't, it fails with instructions to pass it explicitly. Prefer
    reading it off `result`'s output for the thread when in doubt.
```

## What the script handles for you

- Envelope: dispatch bodies are the bare command object, not wrapped in
  `{"command": ...}`.
- Client-generated IDs: `threadId`/`commandId`/`messageId` are UUIDs
  generated locally. The dispatch response is only `{"sequence": N}`, and no
  turn id comes back.
- Completion contract: polls `GET /api/orchestration/threads/:threadId`
  and watches `thread.latestTurn.state`, testing for `!== "running"` (not an
  enumerated allow-list of terminal states, because unrecognized values fall
  back to `"running"` server-side). It does not poll the message list (the
  assistant message only appears at completion). It also treats a missing
  `latestTurn`, which happens for the first instant after `thread.create`
  before `thread.turn.start`'s effect lands, as still running rather than
  done. An earlier version of this script got that wrong and returned
  instantly with an empty message.
- Wall-clock timeout: `running` can be stale indefinitely (orphaned
  turns survive service restarts). Every poll loop has a timeout
  (`--timeout`, default 300s) and reports `TIMED OUT` rather than hanging.
- Coarse errors: a failed dispatch (e.g. a nonexistent thread) comes
  back as a generic HTTP 500 `orchestration_dispatch_failed`. The script
  surfaces the `traceId` from the body so you have something to grep logs
  for, rather than pretending the status code means something specific.
  (Reads via `GET /threads/:id`, by contrast, do return a proper 404
  `thread_not_found`, verified during testing; only the dispatch/write path
  is coarse.)
- Provider failures over HTTP 200: a dispatch can succeed at the
  transport level while the agent itself failed (e.g. "You're out of usage
  credits..."). The script always prints the actual assistant message text.
  It does not claim success just because the HTTP call and the turn state
  both looked fine. Read the printed message, don't just check the exit
  code, when something seems off.
