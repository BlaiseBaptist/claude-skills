---
name: serve-plan
description: Publish, run, check, screenshot, and tear down an HTML plan or report at https://<host>.tail2b35ba.ts.net/<slug>/ on a fleet box. Use whenever you make a plan or report for the user, or when asked to serve, host, preview, or screenshot an HTML page on the tailnet.
---

# serve-plan

Publishes a static HTML directory at `https://<host>.tail2b35ba.ts.net/<slug>/`
using Tailscale's own HTTPS termination. Nothing is port-forwarded or publicly
exposed; any device already on the tailnet can reach it.

Everything is driven by `driver.sh` in this skill directory. Do not hand-run the
`python3 -m http.server` / `tailscale serve` pair — the driver picks a free port,
refuses path collisions, and tears down without touching T3 Code's own mount.

## Why this exists, and what NOT to do

T3 Code already occupies the tailnet HTTPS front door on every onboarded box:
`t3 serve --tailscale-serve` proxies `https://<host>.tail2b35ba.ts.net/` (path
`/`) to T3 Code's port 3773. We add a second, **path-scoped** mount alongside it.
`tailscale serve` supports multiple concurrent mounts keyed by path, so this is
additive.

**Never run `tailscale serve reset` or `tailscale serve --https=443 off`.** Both
take down T3 Code's web UI for everyone on the box, including the service running
you. The second one is the command `tailscale serve` itself prints as the
"disable the proxy" hint right after you mount — ignore it. The only correct
teardown is `--set-path=/<slug> off`, which is what `driver.sh down` runs.

## Run (agent path)

Paths below are relative to this skill directory.

```sh
# 1. Write the page anywhere. index.html is required; relative assets work.
mkdir -p /tmp/myplan && cat > /tmp/myplan/index.html <<'HTML'
<!doctype html><meta charset=utf-8><title>plan</title><h1>plan</h1>
HTML

# 2. Publish it. Prints the URL. <slug> must be [A-Za-z0-9._-]+ and unique to
#    your task, so parallel agents on the same box don't collide.
bash driver.sh up myplan-<unique> /tmp/myplan

# 3. Prove it actually serves — and that T3 Code's / still does.
bash driver.sh check myplan-<unique>

# 4. Look at it before handing the URL over. Writes a PNG; then Read the file.
bash driver.sh shot myplan-<unique>        # -> /tmp/<slug>.png

# 5. Report https://<host>.tail2b35ba.ts.net/<slug>/ to the user.

# 6. Tear down when the plan is no longer needed.
bash driver.sh down myplan-<unique>
```

Other commands:

- `bash driver.sh list` — every mount on the box plus every dir under
  `~/.t3-html-plan`, marked `up` or `orphan`.
- `bash driver.sh demo` — full up/check/asset/screenshot/down on a throwaway
  slug. Run this first if you want to confirm the machinery works before
  publishing anything real. Takes about 5 seconds.

Verified end-to-end on `war` (2026-09-02): `demo` passes, the page renders over
HTTPS in headless chromium, and a second tailnet box (`archlinux`) fetches
`https://war.tail2b35ba.ts.net/<slug>/` with a valid cert and no `-k`.

## Cleanup is not optional

`down` unmounts the path, kills the server, and deletes the dir. Always run it
for throwaway/test slugs. A reboot kills `http.server` but leaves the mount
config and the directory, so stale plans accumulate — `list` shows them as
`orphan`, and `down <slug>` clears one.

## Gotchas

- **`tailscale serve` prints the wrong teardown command.** Its post-mount hint is
  `tailscale serve --https=443 off`, which drops *all* mounts on 443 including
  T3 Code's `/`. Use `--set-path=/<slug> off`.
- **The 8100-8199 range is not free by convention.** On `war`, 8125 is already
  listening and 8443 carries a second `tailscale serve` mount. The driver scans
  with `ss -ltn` and takes the first genuinely free port; don't hardcode 8123.
- **The mount strips the `/<slug>` prefix before proxying.** `http.server` sees
  `GET /style.css`, not `GET /<slug>/style.css`, so **relative** asset paths in
  your HTML work. A root-absolute one (`href="/style.css"`) is worse than a 404:
  it hits T3 Code's `/` mount, which serves its SPA shell with
  `200 text/html` for any unknown path. Your page loads unstyled and nothing
  looks like an error. Write `href="x.css"`, never `href="/x.css"`.
- **`/<slug>` without a trailing slash also returns 200** — Tailscale serves it
  directly rather than redirecting. Still report the trailing-slash form; that's
  what makes relative assets resolve correctly in a browser.
- **A path collision silently replaces the existing mount.** The driver checks
  `tailscale serve status` before mounting and refuses; if you bypass the driver,
  check first.
- **zsh: never use `path` as a loop variable.** `for path in /a /b; do curl ...`
  clobbers `$PATH` (zsh ties `path` to `PATH`) and the rest of your shell command
  dies with `curl: command not found`. Bit me writing this skill.
- **`archlinux` may refuse SSH by name while its Tailscale IP works.** For
  cross-box verification, `ssh blaise@100.91.183.24` succeeded when
  `archlinux.tail2b35ba.ts.net` gave "No route to host".

## Troubleshooting

| Symptom | Fix |
|---|---|
| `driver: no .../index.html -- write the page first` | The dir has assets but no `index.html`. `http.server` would show a directory listing; the driver refuses instead. |
| `driver: /<slug> is already mounted by something else` | Another agent or an earlier run owns that path. Pick a different slug, or `down` the old one. |
| `driver: <slug> is already up; 'down' it first` | State file exists under `~/.t3-html-plan/<slug>/.serve-state`. `down` then `up`. |
| `driver: no free port in 8100-8199` | 100 ports occupied — something is leaking servers. Check `list` and `ps -ef | grep http.server`. |
| `driver: no chromium` | Screenshots use the playwright cache. Install with `npx -y playwright@latest install chromium`; the driver globs the version dir, so upgrades don't break it. |
| `check` shows `T3 Code / ` not 200 | You (or something else) clobbered the root mount. Restart T3 Code's serve — see `t3-fleet-onboard` step 3 / `T3CODE_TAILSCALE_SERVE=true`. |

## Notes

- Works identically on any onboarded fleet box. The mechanism is that box's own
  `tailscale serve`, unrelated to which machine dispatched the work.
- `T3_HTML_PLAN_ROOT` overrides `~/.t3-html-plan` if you need a different scratch
  root.
