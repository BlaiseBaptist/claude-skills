---
name: t3-fleet-onboard
description: Use when onboarding, healing, or running `t3` CLI commands against a T3 Code fleet box.
---

# t3-fleet-onboard

Onboards (or re-verifies / heals) one machine in the T3 Code fleet. Run from
`archlinux` over SSH; `$H` is the target hostname. It is idempotent: re-running
this on a healthy box is a no-op health check, and it's also the intended
fix for an expired bearer (nothing else re-checks that).

Fleet devices talk to each other over Tailscale directly (`tailscale serve`,
step 3 below). T3 Connect (phone-relay pairing) is not part of this setup.

## Preflight gate, before touching anything

1. **Ownership.** `archlinux`, `littlearch`, `bigarch`, and `war` are
   eligible (`war` was reclassified from shared to the user's own machine on
   2026-08-12). `nuc`, `teddy-computer`, `lovelandnuc` are **shared machines
   and must never be installed on**, even though some are SSH-reachable.
   `scripts/onboard.mjs` also enforces this internally and will refuse, but
   check it yourself first; don't rely only on the script catching it.
2. **Reachability.** Run `tailscale status` and confirm `$H` shows up and isn't
   obviously offline. This is advisory (the status column can be stale);
   the real gate is the SSH attempt itself.
3. **SSH, always the same way**: `ssh -o BatchMode=yes blaise@$H true`.
   - If this fails on key auth (`Permission denied`, `publickey`) or can't
     reach the host: **stop and tell the user.** Never fall through to a
     password prompt, never try a different username.
   - `-o BatchMode=yes` on every SSH call in this skill, no exceptions.

If any of these fail, do not proceed to installation.

## Steps 1-4: install (plain SSH, no secrets, run directly)

These are naturally re-runnable; running them on an already-healthy box is a
no-op.

**1. User-local Node 24** (no pacman/sudo, works on any distro):

```sh
ssh -o BatchMode=yes blaise@$H '
  set -e
  test -x ~/.local/share/t3-node/bin/node || {
    mkdir -p ~/.local/share/t3-node
    curl -fsSL https://nodejs.org/dist/v24.19.0/node-v24.19.0-linux-x64.tar.xz \
      | tar -xJ --strip-components=1 -C ~/.local/share/t3-node
  }
  ~/.local/share/t3-node/bin/node --version'
```

**2. Install the service, pinned version** (`0.0.33`; see "Version pin"
below, and never `@latest`):

```sh
ssh -o BatchMode=yes blaise@$H '
  export PATH="$HOME/.local/share/t3-node/bin:$PATH"
  env -u T3_SERVICE_LAUNCHER_CONTEXT npx -y t3@0.0.33 service install'
```

> Sequencing warning from the design doc: if archlinux itself isn't already
> updated to the same pinned version, onboarding a box at a newer version
> manufactures a CLI↔service skew in the opposite direction. Check
> archlinux's version first (`t3 --version` / `~/.t3/runtime/versions/`) if
> this ever drifts from the pin below.

**3. Tailscale serve drop-in** (the installer does not set this; write the
file directly, because `systemctl --user edit` opens an interactive editor
and hangs under `BatchMode=yes`):

```sh
ssh -o BatchMode=yes blaise@$H '
  mkdir -p ~/.config/systemd/user/t3code.service.d
  printf "[Service]\nEnvironment=T3CODE_TAILSCALE_SERVE=true\n" \
    > ~/.config/systemd/user/t3code.service.d/override.conf
  systemctl --user daemon-reload
  systemctl --user restart t3code.service
  loginctl enable-linger blaise'
```

**4. Provider CLI: presence isn't enough, it must be logged in.** There's
no cheap standalone check for this; step 7 check 4 (the `pong` dispatch) is
the real proof. If that check fails later, come back here: the daemon can be
`active (running)` with zero working agents and look perfectly healthy while
being useless.

## Skills repo

Skills reach `$H` as plugins from the `blaise-skills` marketplace
(`https://github.com/BlaiseBaptist/claude-skills`, public, no auth needed).
`~/.claude/skills` is no longer a clone of that repo; it holds box-local
skills.

Both commands are idempotent: `marketplace add` re-registers an existing
marketplace in place, and `install` on an already-installed plugin is a no-op.
Use the HTTPS URL. The `owner/repo` shorthand clones over SSH, and fleet
boxes have no GitHub SSH key.

```sh
ssh -o BatchMode=yes blaise@$H '
  set -e
  export PATH="$HOME/.local/bin:$PATH"
  claude plugin marketplace add https://github.com/BlaiseBaptist/claude-skills.git
  claude plugin install t3-fleet@blaise-skills --scope user
  claude plugin list'
```

`t3-fleet` is the only plugin every box needs. Add others per box, so a
headless box doesn't carry desktop skills:

```sh
# littlearch only (Sway desktop)
claude plugin install desktop@blaise-skills --scope user
```

### Keeping it in sync afterwards

Claude Code's background auto-update refreshes marketplaces and installed
plugins after a session starts, but only after a random delay of up to ten
minutes. T3-launched turns are routinely shorter than that, so on this fleet
it fires erratically. Drive it from a user timer instead.

Two things the timer has to get right:

- `claude plugin marketplace update` only refreshes the catalog. Rolling
  installed plugins forward takes `claude plugin update <plugin>`. A timer
  that runs only the first command reports success forever while every box
  stays pinned at the version it was installed with.
- The unit must not point at anything under `${CLAUDE_PLUGIN_ROOT}`. That
  path carries the plugin version and moves on every update, so a unit
  referencing it breaks the first time an update lands. Install the sync
  script to a stable path outside the plugin cache.

Ship the script, then the units:

```sh
ssh -o BatchMode=yes blaise@$H 'mkdir -p ~/.local/bin && cat > ~/.local/bin/claude-skills-sync && chmod +x ~/.local/bin/claude-skills-sync' \
  < ${CLAUDE_PLUGIN_ROOT}/skills/t3-fleet-onboard/scripts/claude-skills-sync.sh
```

```sh
ssh -o BatchMode=yes blaise@$H '
  set -e
  mkdir -p ~/.config/systemd/user
  cat > ~/.config/systemd/user/claude-skills-sync.service <<EOF
[Unit]
Description=Sync blaise-skills plugins

[Service]
Type=oneshot
ExecStart=%h/.local/bin/claude-skills-sync
EOF
  cat > ~/.config/systemd/user/claude-skills-sync.timer <<EOF
[Unit]
Description=Sync blaise-skills plugins hourly

[Timer]
OnBootSec=5min
OnUnitActiveSec=1h
Persistent=true

[Install]
WantedBy=timers.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now claude-skills-sync.timer
  systemctl --user list-timers claude-skills-sync.timer --no-pager'
```

`loginctl enable-linger blaise` (step 3) lets this run without an active
login session, and is already set by the time you get here.

An update only takes effect in sessions started after it lands; `claude
plugin update` says as much ("Restart to apply changes"). Long-lived T3
threads keep the version they launched with, which is what you want
mid-task.

Version pinning works the same way it does for T3 itself: with no `version`
field in `plugin.json`, each plugin tracks the marketplace repo's current
commit, so every push reaches the fleet on the next sync. Set `version` in
`plugin.json` if you ever want boxes to hold still until you bump it.

## Optional: pair the T3 Code site's browser "Connect" button

For linking a box so the browser/site client can talk to it directly (the
"Connect" button under site settings). It is not needed for machine-to-machine
fleet dispatch, which already works via the bearer in `hosts.json`.

```sh
ssh -o BatchMode=yes blaise@$H '
  export PATH="$HOME/.local/share/t3-node/bin:$PATH"
  env -u T3_SERVICE_LAUNCHER_CONTEXT npx -y t3@0.0.33 pair --tailscale --label archlinux-pairing'
```

Prints a `https://$H.tail2b35ba.ts.net/pair#token=...` URL (plus QR code).
Open it in the browser to complete pairing. The token is short-lived
(`--ttl`, default 5 minutes), so run this right before you're going to use
it, not ahead of time. `--tailscale` is the flag that matters: it pairs
through the tailnet URL directly, the same path everything else in this
skill uses.

**Do not confuse this with `t3 connect link` / `t3 connect` (T3 Connect,
the phone-relay pairing feature).** That's a different mechanism (installs
a `cloudflared` relay client, routes off-tailnet) that was deliberately left
out of this fleet's setup. If a user asks for a "pairing link" or "pairing
token" for a fleet box, this `t3 pair --tailscale` command is very likely
what they mean, not `connect link`.

## Steps 5-7: bundled script (API-heavy, secret-handling, do not hand-roll)

`project.create`, the bearer mint/rotate, and the four verification checks
are fiddly JSON-over-HTTPS with UUID generation and a real secret in the
loop. Use the script rather than assembling dispatch bodies by hand:

```sh
node ${CLAUDE_PLUGIN_ROOT}/skills/t3-fleet-onboard/scripts/onboard.mjs $H
```

Optional flags: `--workspace-root PATH` (default `/home/blaise`), `--title
TITLE` (default `"$H Main"`), `--label LABEL` (default `archlinux-agent`),
`--t3-version VERSION` (default `0.0.33`), `--skip-verify` (skip step 7;
only use this for a deliberately partial run, e.g. re-minting a token
without re-testing dispatch).

What it does, and why each guard exists:

- Step 6 (mint bearer) runs first, over SSH, because steps 5 and 7 both
  need an authenticated request and there is no bootstrap credential to read
  the snapshot with otherwise. It lists existing sessions on `$H` for
  `--label`, revokes any it finds, then mints a fresh one. It rotates rather
  than stacks, because every CLI-issued token carries `access:write`
  (root-equivalent on that box) and a naive re-run would otherwise leave
  orphaned root-equivalent tokens accumulating. The token is written
  straight into `~/.config/fleet/hosts.json` (mode 0600) and is never
  printed: not to stdout, not to stderr, not into this transcript.
- Step 5 (project.create) is snapshot-guarded: it does `GET /snapshot`
  first and only creates if `workspaceRoot` isn't already present. A second
  `project.create` at an existing `workspaceRoot` returns a generic 500
  indistinguishable from a real server error, so the guard checks the
  snapshot rather than create-and-ignore-the-error. If you see a 400 here,
  it means `workspaceRoot` doesn't exist yet on `$H`, and the script does not
  `mkdir` it for you (that's a remote filesystem change outside its scope);
  do it over SSH and re-run.
- Step 7 runs all four checks and treats the run as failed if any one of
  them fails. An install that can't prove itself working end to end is a
  failed run, not a partial success:
  1. `systemctl --user is-active t3code.service` → `active`
  2. `GET /api/orchestration/snapshot` with the bearer → 200 (and, as a
     control, without a bearer → 401)
  3. snapshot `projects[]` contains the `workspaceRoot`
  4. a real dispatch: `thread.create` → `thread.turn.start` *"Reply with
     exactly: pong"* → poll `latestTurn.state` (not the message list, not an
     enumerated terminal-state list, just `!== "running"`, with a
     wall-clock timeout) → read the assistant message text → `thread.delete`
     regardless of outcome. This is the only check that proves the provider
     CLI is actually authenticated, and its result must come from the
     message content: a provider failure ("You're out of usage credits...")
     is a normal HTTP 200 with a normal-looking assistant message, not an
     error status.

The script exits non-zero (and the skill should report FAILURE, not
"partially done") if any check fails.

## Version pin

`0.0.33`, hardcoded as `DEFAULT_T3_VERSION` at the top of
`scripts/onboard.mjs` and in the step 1-4 commands above. Bump both places
together when moving the fleet to a new version, and update archlinux itself
first (see the sequencing warning in step 2).

## Secret hygiene

- The bearer never appears in this skill's own output, in `SKILL.md`, or in
  any command the agent runs directly. Only `scripts/onboard.mjs` ever
  touches the raw token, and only to write it into
  `~/.config/fleet/hosts.json` (mode 0600).
- If you ever find yourself about to type a token into a Bash command or
  print it to check it "looks right", don't. Every step above that needs
  the token routes it through the script instead.

## `T3_SERVICE_LAUNCHER_CONTEXT` trap

Any `t3` CLI invocation, here or anywhere else, must run as `env -u
T3_SERVICE_LAUNCHER_CONTEXT t3 ...`. A Claude Code session hosted *by*
t3code inherits that variable, and every `t3 connect`/`pair`/`auth` call
then fails with `ipc-unavailable`. This is why every remote command in this
skill is wrapped that way, and it's also why this skill's description says
to load it before running any `t3` CLI command against a fleet box, even
outside an onboarding run.
