---
name: t3-fleet-onboard
description: Onboarding, healing, or running `t3` commands on a T3 Code fleet box.
---

# t3-fleet-onboard

Onboards (or re-verifies / heals) one machine in the T3 Code fleet. Run from
`archlinux` over SSH; `$H` is the target hostname. It is idempotent: re-running
this on a healthy box is a no-op health check.

**Two box shapes, and every step below branches on which one you have.**

| | Linux box (`archlinux`, `war`, `bigarch`, `littlearch`) | Mac (`blaises-macbook-air`, `blaises-mini`) |
|---|---|---|
| T3 Code | CLI service, `t3code.service` under systemd --user | **desktop app**, `T3 Code (Alpha).app`, no service unit |
| `t3` on `PATH` | yes (via `npx t3@latest`) | **no, and there is nothing to install** |
| Serve mount | `T3CODE_TAILSCALE_SERVE=true` drop-in | `tailscale serve` by hand |
| Skills sync | systemd user timer | launchd `LaunchAgent` |

Decide first, and keep the answer for every later step:

```sh
ssh -o BatchMode=yes blaise@$H 'uname -s'   # Linux | Darwin
```

On a Mac, step 2 has no counterpart at all: the desktop app is installed by its
`.app` bundle (the `t3-code` Homebrew cask, or a download), it self-updates, and
`t3 service install` is not a thing there. Step 3 has a different counterpart —
`tailscale serve` by hand instead of a systemd drop-in. Do not try to install a
service on a Mac, and do not "fix" a Mac by reaching for `systemctl`.

Fleet work is plain SSH (`ssh -o BatchMode=yes blaise@$H '<command>'`). There is
no bearer, no `hosts.json`, and no bundled onboarding script anymore; the old
`scripts/onboard.mjs` and its `access:write` token mint were removed when
`fleet-dispatch` went away.

Fleet devices talk to each other over Tailscale directly (`tailscale serve`,
step 3 below). T3 Connect (phone-relay pairing) is not part of this setup.

## Preflight gate, before touching anything

1. **Ownership.** `archlinux`, `littlearch`, `bigarch`, `war`,
   `blaises-macbook-air`, and `blaises-mini` are eligible (`war` was
   reclassified from shared to the user's own machine on 2026-08-12; the two
   Macs joined on 2026-09-17 and 2026-09-22). `nuc`, `teddy-computer`,
   `lovelandnuc`, `m1airlinux` are **shared or out of scope and must never be
   installed on**, even though some are SSH-reachable. Nothing enforces this
   for you now that the bundled script is gone; it is on you to check the
   target before running any install step.
2. **Reachability.** Run `tailscale status` and confirm `$H` shows up and isn't
   obviously offline. This is advisory (the status column can be stale);
   the real gate is the SSH attempt itself.
3. **SSH, always the same way**: `ssh -o BatchMode=yes blaise@$H true`.
   - If this fails on key auth (`Permission denied`, `publickey`) or can't
     reach the host: **stop and tell the user.** Never fall through to a
     password prompt, never try a different username.
   - `-o BatchMode=yes` on every SSH call in this skill, no exceptions.
   - On a **Mac that refuses the connection**, the cause is almost always that
     macOS Remote Login is off, and you cannot fix it from here — see
     "Tailscale SSH" below, then stop and tell the user.
   - A box that answers SSH by name is **not** proof its name resolves
     correctly. `sshd` binds every interface, so a stale LAN record still
     answers port 22 while `tailscale serve` (tailnet-only) does not answer
     443. If SSH works but the `curl` in Verify hangs, compare
     `getent hosts $H.tail2b35ba.ts.net` against `tailscale status | grep $H`
     and dial the `100.x` address.

If any of these fail, do not proceed to installation.

## Tailscale SSH: turn it on if it isn't already

Key-based SSH is how this skill drives a box, and it stays that way. Tailscale
SSH is the backstop: it authenticates by tailnet identity instead of by key, so
it still lets you in after a key rotation, a reinstall, or a fresh box whose
`authorized_keys` is empty. Enable it on every box you onboard.

Check first — this is a no-op on a box that already has it:

```sh
# from any fleet box, about the target
tailscale status --json | jq -r --arg h "$H" \
  '.Peer[] | select(.HostName==$h) | "\(.HostName) tailscaleSSH=\((.sshHostKeys|length)>0)"'
```

`tailscaleSSH=true` means the node advertises SSH host keys and there is
nothing to do. If it says `false`, turn it on **on the target**:

```sh
ssh -o BatchMode=yes blaise@$H 'tailscale set --ssh && tailscale debug prefs | grep -i runssh'
```

Then prove it, from a different box — the pref alone proves nothing:

```sh
tailscale ssh blaise@$H 'echo tailscale-ssh-ok; hostname'
```

Three ways this bites:

- **`tailscale set` needs root or operator.** Every fleet box has
  `"OperatorUser": "blaise"` in its prefs, so the command works unprivileged.
  On a box without it you get an access error, and `sudo tailscale set --ssh`
  needs a password `war` and `archlinux` do not have passwordless. Hand it to
  the user rather than guessing.
- **The tailnet ACL has to allow it.** Tailscale SSH is rejected without an
  `ssh` rule in the tailnet policy, regardless of what the node advertises.
  That lives in the admin console, not on the box.
- **On a Mac it is not a substitute for Remote Login.** `tailscale set --ssh`
  exits 0 and flips `"RunSSH": true` whether or not anything can serve. On
  `blaises-mini` on 2026-09-22 the pref was true for hours while port 22 stayed
  closed and callers got `Connection refused`; the node only began advertising
  host keys after macOS Remote Login was switched on at the keyboard. Treat
  Remote Login as the requirement and Tailscale SSH as the backstop, and never
  read `RunSSH: true` as evidence of access — the evidence is a connection.

**Enabling Remote Login on a Mac** cannot be done from here: it needs sudo at
the keyboard, which neither Mac has passwordless. Ask the user to do it in
System Settings > General > Sharing > Remote Login, or at a terminal there:

```sh
sudo systemsetup -setremotelogin on
# if that is blocked by Full Disk Access:
sudo launchctl enable system/com.openssh.sshd
sudo launchctl bootstrap system /System/Library/LaunchDaemons/ssh.plist
```

Then authorize the fleet's keys, still at the Mac, so `BatchMode=yes` works:

```sh
ssh blaise@war.tail2b35ba.ts.net 'cat ~/.ssh/id_ed25519.pub' >> ~/.ssh/authorized_keys
ssh blaise@archlinux.tail2b35ba.ts.net 'cat ~/.ssh/id_ed25519.pub' >> ~/.ssh/authorized_keys
chmod 700 ~/.ssh; chmod 600 ~/.ssh/authorized_keys
```

Outbound SSH from a Mac works before inbound does, which is what makes that
pull possible. If it fails with `Host key verification failed`, the Mac's
`known_hosts` has the box under a short name only; dial the FQDN once
interactively and accept the key.

## Steps 1-4: install (plain SSH, no secrets, run directly)

These are naturally re-runnable; running them on an already-healthy box is a
no-op.

**1. User-local Node 24** (no pacman/sudo/brew, works on any distro and on
macOS). The tarball is per-platform, so pick it from `uname`:

```sh
ssh -o BatchMode=yes blaise@$H '
  set -e
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64)  NODE_PLAT=linux-x64 ;;
    Linux-aarch64) NODE_PLAT=linux-arm64 ;;
    Darwin-arm64)  NODE_PLAT=darwin-arm64 ;;
    Darwin-x86_64) NODE_PLAT=darwin-x64 ;;
    *) echo "unknown platform: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
  esac
  test -x ~/.local/share/t3-node/bin/node || {
    mkdir -p ~/.local/share/t3-node
    curl -fsSL "https://nodejs.org/dist/v24.19.0/node-v24.19.0-$NODE_PLAT.tar.xz" \
      | tar -xJ --strip-components=1 -C ~/.local/share/t3-node
  }
  ~/.local/share/t3-node/bin/node --version'
```

The old hardcoded `node-v24.19.0-linux-x64.tar.xz` was wrong OS *and* wrong
arch on an M-series Mac, and was one of the two reasons both Macs were
onboarded by hand. Macs ship no `node` of their own — `blaises-mini` had none
on 2026-09-22 — so this step matters there even though T3 itself is an app.

**2. Install the service** at whatever is current. **Linux only** — skip to
step 3 on a Mac:

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

> **On a Mac there is nothing to install here.** T3 Code is the desktop app;
> it has no service unit, no `t3` on `PATH`, and it updates itself. Confirm the
> app is up instead, and stop if it isn't — a Mac with no running app is a
> user-facing problem (launch it from the Dock), not something to fix over SSH:
>
> ```sh
> ssh -o BatchMode=yes blaise@$H '
>   pgrep -f "T3 Code" >/dev/null && echo app-running || echo app-not-running
>   curl -fsS -o /dev/null -w "local:%{http_code}\n" http://127.0.0.1:3773/'
> ```
>
> Expect `app-running` and `local:200`. Note the two Macs differ on where the
> bundle lives — `blaises-mini` runs it from `/Applications`, the Air only works
> from `~/Applications` — so do not relocate one to match the other.

**3. Tailscale serve.** Both shapes end up serving the web UI at
`https://$H.tail2b35ba.ts.net/`, by different routes.

*Linux* — set the drop-in (the installer does not set this; write the file
directly, because `systemctl --user edit` opens an interactive editor and hangs
under `BatchMode=yes`):

```sh
ssh -o BatchMode=yes blaise@$H '
  mkdir -p ~/.config/systemd/user/t3code.service.d
  printf "[Service]\nEnvironment=T3CODE_TAILSCALE_SERVE=true\n" \
    > ~/.config/systemd/user/t3code.service.d/override.conf
  systemctl --user daemon-reload
  systemctl --user restart t3code.service
  loginctl enable-linger blaise'
```

*macOS* — nothing sets it for you, so mount it by hand. Idempotent:

```sh
ssh -o BatchMode=yes blaise@$H '
  export PATH=/opt/homebrew/bin:$PATH
  tailscale serve --bg --set-path=/ http://127.0.0.1:3773
  tailscale serve status'
```

While you are there, **pin the tailnet name** on a Mac. Unpinned, `Hostname` is
empty in prefs and control takes the macOS name, so any `tailscaled` restart —
a `brew upgrade` will do it — renames the node. That walked the Air up to
`blaises-macbook-air-2` on 2026-09-17, and a Serve config does **not** follow a
rename: it keeps serving the old name and rejects callers until re-set.

```sh
# "Hostname": ""  means unpinned
ssh -o BatchMode=yes blaise@$H 'PATH=/opt/homebrew/bin:$PATH tailscale debug prefs | grep -i hostname'
# only if it came back empty or wrong:
ssh -o BatchMode=yes blaise@$H "PATH=/opt/homebrew/bin:\$PATH tailscale set --hostname=$H"
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
  export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"
  claude plugin marketplace add https://github.com/BlaiseBaptist/claude-skills.git
  claude plugin install t3-fleet@blaise-skills --scope user
  claude plugin list'
```

`/opt/homebrew/bin` is in there for the Macs, where `claude` is the Homebrew
cask (`blaises-mini`) — harmless on Linux, where the path does not exist. The
Air is the exception: its `claude` is the npm install under `~/.local/bin`,
because the cask binary tripped Gatekeeper on every upgrade there.

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

**On a Mac, launchd replaces both units.** Same script, same hourly cadence;
`StartInterval` counts from load and `RunAtLoad` covers the boot case that
`OnBootSec=` handles on Linux. There is no linger equivalent — a LaunchAgent
runs when the user is logged in, which on these Macs is always.

```sh
ssh -o BatchMode=yes blaise@$H 'mkdir -p ~/.local/bin && cat > ~/.local/bin/claude-skills-sync && chmod +x ~/.local/bin/claude-skills-sync' \
  < ${CLAUDE_PLUGIN_ROOT}/skills/t3-fleet-onboard/scripts/claude-skills-sync.sh
```

```sh
ssh -o BatchMode=yes blaise@$H '
  set -e
  mkdir -p ~/Library/LaunchAgents
  cat > ~/Library/LaunchAgents/com.blaise.claude-skills-sync.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.blaise.claude-skills-sync</string>
  <key>ProgramArguments</key>
  <array>
    <string>$HOME/.local/bin/claude-skills-sync</string>
  </array>
  <key>StartInterval</key><integer>3600</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/claude-skills-sync.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/claude-skills-sync.log</string>
</dict>
</plist>
EOF
  launchctl bootout gui/$(id -u)/com.blaise.claude-skills-sync 2>/dev/null || true
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.blaise.claude-skills-sync.plist
  launchctl print gui/$(id -u)/com.blaise.claude-skills-sync | head -5'
```

`bootout` before `bootstrap` is what makes this re-runnable; `bootstrap` alone
fails with `Bootstrap failed: 5: Input/output error` once the label is loaded.
Check it actually ran with
`tail ~/Library/Logs/claude-skills-sync.log`, not with the exit code.

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

**Linux only** — a Mac has no `t3` CLI. Pair from the app's own UI there.

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

**1. T3 Code up:**

```sh
# Linux
ssh -o BatchMode=yes blaise@$H 'systemctl --user is-active t3code.service'
# macOS -- no service unit exists; check the app and the port it binds
ssh -o BatchMode=yes blaise@$H '
  pgrep -f "T3 Code" >/dev/null && echo app-running || echo app-not-running
  curl -fsS -o /dev/null -w "local:%{http_code}\n" http://127.0.0.1:3773/'
```

Expect `active` on Linux, `app-running` and `local:200` on a Mac.

**2. Tailscale serve routing the web UI:**

```sh
curl -fsS -o /dev/null -w '%{http_code}\n' https://$H.tail2b35ba.ts.net/
```

Expect `200`. On a hang or 502, re-check step 3 (the `T3CODE_TAILSCALE_SERVE`
drop-in) and `ssh -o BatchMode=yes blaise@$H 'tailscale serve status'`.

**3. Provider CLI actually logged in** — the check that matters, and the one a
healthy-looking daemon won't give you:

```sh
# Linux
ssh -o BatchMode=yes blaise@$H 'timeout 90 claude -p "Reply with exactly: pong"'
# macOS -- there is no `timeout` (and no `gtimeout` unless coreutils is
# installed), so bound it from this side instead
ssh -o BatchMode=yes -o ConnectTimeout=10 blaise@$H \
  'export PATH=$HOME/.local/bin:/opt/homebrew/bin:$PATH; claude -p "Reply with exactly: pong"'
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

A Linux box onboarded before the SSH switch still has a leftover `access:write`
session (label `*-agent`) that nothing uses now. Neither Mac ever had one. List and revoke it over SSH:

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

## macOS traps

Four things that will waste your time on a Mac, all of them hit on
`blaises-mini` during its 2026-09-22 onboarding:

- **`PATH` under non-interactive SSH.** `ssh blaise@$H '<cmd>'` does not run a
  login shell, so Homebrew's `/opt/homebrew/bin` may be missing and `tailscale`,
  `claude` and `brew` come back `command not found`. It is easy to misread that
  as "not installed" or "the command failed". Export the path explicitly in
  every remote command, as the steps above do.
- **No `timeout`.** macOS ships neither `timeout` nor `gtimeout`. Any command
  built around them dies instantly with `command not found`, and if it is inside
  a `||` fallback you get a silent wrong answer rather than an error.
- **No `t3` CLI at all.** Every `npx -y t3@latest ...` command in this skill —
  `service install`, `pair`, `auth session list` — has no counterpart on a Mac.
  Pairing is done from the app's UI.
- **Name resolution, twice over.** A Mac's tailnet name drifts unless pinned
  (step 3), and `war` resolves both Macs to stale LAN addresses, so
  `https://$H.tail2b35ba.ts.net/` can fail from `war` while the box is perfectly
  healthy. Verify from `archlinux`, or `curl --resolve` the `100.x` address.

## `T3_SERVICE_LAUNCHER_CONTEXT` trap

Any `t3` CLI invocation, here or anywhere else, must run as `env -u
T3_SERVICE_LAUNCHER_CONTEXT t3 ...`. (Linux boxes only; the Macs have no `t3`.) A Claude Code session hosted *by*
t3code inherits that variable, and every `t3 connect`/`pair`/`auth` call
then fails with `ipc-unavailable`. This is why every remote command in this
skill is wrapped that way, and it's also why this skill's description says
to load it before running any `t3` CLI command against a fleet box, even
outside an onboarding run.
