---
name: t3-fleet-onboard
description: Onboarding, healing, or running `t3` commands on a T3 Code fleet box.
---

# t3-fleet-onboard

Onboards (or re-verifies / heals) one machine in the T3 Code fleet. Run from
`archlinux` over SSH; `$H` is the target hostname. It is idempotent: re-running
this on a healthy box is a no-op health check.

Fleet work is plain SSH (`ssh -o BatchMode=yes blaise@$H '<command>'`). There is
no bearer, no `hosts.json`, and no bundled onboarding script anymore; the old
`scripts/onboard.mjs` and its `access:write` token mint were removed when
`fleet-dispatch` went away.

Fleet devices talk to each other over Tailscale directly (`tailscale serve`,
step 3 below). T3 Connect (phone-relay pairing) is not part of this setup.

## Preflight gate, before touching anything

1. **Ownership.** `archlinux`, `littlearch`, `bigarch`, and `war` are
   eligible (`war` was reclassified from shared to the user's own machine on
   2026-08-12). `nuc`, `teddy-computer`, `lovelandnuc` are **shared machines
   and must never be installed on**, even though some are SSH-reachable.
   Nothing enforces this for you now that the bundled script is gone; it is
   on you to check the target before running any install step.
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

**2. Install the service** at whatever is current:

```sh
ssh -o BatchMode=yes blaise@$H '
  export PATH="$HOME/.local/share/t3-node/bin:$PATH"
  env -u T3_SERVICE_LAUNCHER_CONTEXT npx -y t3@latest service install'
```

> Boxes need not match each other. Within one box, though, the CLI you
> invoke must match the service that box runs, or the call fails with `The
> service launcher started a different t3 version.` Using `t3@latest` for
> the install and for later commands keeps them aligned. For a box you have
> deliberately held back, read its running version out of
> `~/.t3/runtime/versions/` and pass that exact version to `npx`.

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
no cheap standalone check for this; the `pong` check in "Verify" below
(`ssh blaise@$H 'claude -p ...'`) is the real proof. If it fails later, come
back here: the daemon can be `active (running)` with zero working agents and
look perfectly healthy while being useless. The fix is an interactive login:
`ssh -t blaise@$H claude`, then `/login`.

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

Three things the timer has to get right:

- `claude plugin marketplace update` only refreshes the catalog. Rolling
  installed plugins forward takes `claude plugin update <plugin>`. A timer
  that runs only the first command reports success forever while every box
  stays pinned at the version it was installed with.
- The unit must not point at anything under `${CLAUDE_PLUGIN_ROOT}`. That
  path carries the plugin version and moves on every update, so a unit
  referencing it breaks the first time an update lands. Install the sync
  script to a stable path outside the plugin cache.
- systemd hands a unit `PATH=/usr/local/bin:/usr/bin`, which is not where
  everything lives. `claude` sits in `~/.local/bin` on some boxes and
  `/usr/bin` on others, and littlearch has no system `node` at all, only the
  Node 24 from step 1. The shipped script prepends both `~/.local/bin` and
  `~/.local/share/t3-node/bin` for that reason. Check with
  `systemd-run --user --wait --pipe --quiet /bin/sh -c 'command -v claude; command -v node'`
  before trusting a new box's timer.

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
"Connect" button under site settings). It is not needed for fleet work, which
is plain SSH.

```sh
ssh -o BatchMode=yes blaise@$H '
  export PATH="$HOME/.local/share/t3-node/bin:$PATH"
  env -u T3_SERVICE_LAUNCHER_CONTEXT npx -y t3@latest pair --tailscale --label archlinux-pairing'
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

## Verify (plain SSH, from archlinux)

Run all three. Any failure is a failed onboarding run, not a partial success:
an install that can't prove itself working end to end is a failed run.

**1. Service active:**

```sh
ssh -o BatchMode=yes blaise@$H 'systemctl --user is-active t3code.service'
```

Expect `active`.

**2. Tailscale serve routing the web UI:**

```sh
curl -fsS -o /dev/null -w '%{http_code}\n' https://$H.tail2b35ba.ts.net/
```

Expect `200`. On a hang or 502, re-check step 3 (the `T3CODE_TAILSCALE_SERVE`
drop-in) and `ssh -o BatchMode=yes blaise@$H 'tailscale serve status'`.

**3. Provider CLI actually logged in** — the check that matters, and the one a
healthy-looking daemon won't give you:

```sh
ssh -o BatchMode=yes blaise@$H 'timeout 90 claude -p "Reply with exactly: pong"'
```

The output must contain `pong`. `claude -p` exits 0 even when auth has lapsed
(`Failed to authenticate: OAuth session expired and could not be refreshed`),
so read the output, do not trust the exit code. Fix a failure with an
interactive login: `ssh -t blaise@$H claude`, then `/login`.

## Project for the box

Each box gets one T3 project rooted at its workspace dir (default
`/home/blaise`, title convention `"$H Main"`). Creating it is no longer
scripted: open `https://$H.tail2b35ba.ts.net/` and add the project there if it
isn't already listed.

## Retiring the old bearer

A box onboarded before the SSH switch still has a leftover `access:write`
session (label `*-agent`) that nothing uses now. List and revoke it over SSH:

```sh
ssh -o BatchMode=yes blaise@$H '
  export PATH="$HOME/.local/share/t3-node/bin:$PATH"
  env -u T3_SERVICE_LAUNCHER_CONTEXT npx -y t3@latest auth session list'
# then, per stale session id:
ssh -o BatchMode=yes blaise@$H '
  export PATH="$HOME/.local/share/t3-node/bin:$PATH"
  env -u T3_SERVICE_LAUNCHER_CONTEXT npx -y t3@latest auth session revoke <id>'
```

Once every box's session is revoked, delete `~/.config/fleet/hosts.json` on
`archlinux`.

## Versions

No fleet-wide pin. Every box installs and updates from `latest` on its own
schedule, so they may sit on different versions at any moment. A box ahead of
archlinux is working as intended.

`npx t3@latest service update` moves a box forward, and the app can trigger
the same update over RPC. To hold one box at a specific version on purpose,
install that exact version (`npx -y t3@<version> service install`); nothing
re-pins it afterwards, so undo it yourself.

## `T3_SERVICE_LAUNCHER_CONTEXT` trap

Any `t3` CLI invocation, here or anywhere else, must run as `env -u
T3_SERVICE_LAUNCHER_CONTEXT t3 ...`. A Claude Code session hosted *by*
t3code inherits that variable, and every `t3 connect`/`pair`/`auth` call
then fails with `ipc-unavailable`. This is why every remote command in this
skill is wrapped that way, and it's also why this skill's description says
to load it before running any `t3` CLI command against a fleet box, even
outside an onboarding run.
