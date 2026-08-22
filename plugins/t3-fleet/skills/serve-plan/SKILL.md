---
name: serve-plan
description: Use whenever you make a plan or report for the user.
---

# serve-plan

Publishes a static HTML file at `https://<host>.tail2b35ba.ts.net/<slug>/` using
Tailscale's own HTTPS termination — no port-forwarding, no public exposure,
reachable from any device already on the tailnet.

## Why this exists, and what NOT to do

T3 Code itself already occupies the tailnet HTTPS front door on every onboarded
box: `t3 serve --tailscale-serve` runs `tailscale serve` under the hood to proxy
`https://<host>.tail2b35ba.ts.net/` (path `/`) to T3 Code's own port 3773 (see
`t3-fleet-onboard` step 3 / `T3CODE_TAILSCALE_SERVE=true`). **Do not run
`tailscale serve reset` or overwrite the `/` mapping** — that takes down T3
Code's own web UI for everyone on that box, including the service that's running
you.

Instead, add a **second, path-scoped** `tailscale serve` mapping alongside the
existing `/` one. `tailscale serve` supports multiple concurrent mounts on the
same host, each keyed by path, so this is additive and safe.

## Steps

1. Write the HTML to a scratch directory, e.g.
   `~/.t3-html-plan/<slug>/index.html`. Pick `<slug>` unique to your task (like
   the screenshot skill's naming convention) so parallel agents on the same box
   don't collide.

2. Serve it locally on loopback, on a free port (pick something outside 3773 and
   other known service ports, e.g. in the 8100-8199 range):

   ```sh
   python3 -m http.server 8123 --bind 127.0.0.1 --directory ~/.t3-html-plan/<slug> &
   ```

   Keep the PID — you'll want to kill it during cleanup.

3. Add the path-scoped tailnet mapping (does not disturb the existing `/`
   mapping for T3 Code):

   ```sh
   tailscale serve --bg --set-path=/<slug> 8123
   ```

4. Confirm both mappings coexist:

   ```sh
   tailscale serve status
   ```

   Expect to see both `/` (T3 Code, proxying to 3773) and `/<slug>` (your new
   mapping, proxying to 8123).

5. Report the URL to the user: `https://<host>.tail2b35ba.ts.net/<slug>/`
   (`<host>` is the box's Tailscale hostname, e.g. `archlinux`, `littlearch`,
   `bigarch`, `war` — check with `tailscale status` if unsure which box you're
   on).

## Cleanup

When the plan is no longer needed (or definitely before ending a throwaway/test
run):

```sh
tailscale serve --set-path=/<slug> off
kill <python http.server PID>
rm -rf ~/.t3-html-plan/<slug>
```

Verify with `tailscale serve status` that only `/` (T3 Code's own mapping)
remains. Leaving stray path mounts around after a test session is the equivalent
of leaving orphaned processes running — clean up like you would any other probe.

## Notes

- This works identically on any onboarded fleet box, not just the one you're
  running on — the mechanism is the box's own `tailscale serve`, unrelated to
  which machine dispatched the work.
- If `python3 -m http.server` isn't desired (e.g. you want directory listings
  off, or need more than static files), any local HTTP server bound to
  `127.0.0.1` on a free port works the same way — only the
  `tailscale serve --set-path` step matters for tailnet exposure.
- Don't reuse `/`, and don't reuse another mapping's path or port without
  checking `tailscale serve status` first — a collision silently replaces the
  existing mapping.
