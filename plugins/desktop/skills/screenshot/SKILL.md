---
name: screenshot
description: Use proactively whenever you need to visually verify a GUI/visual change yourself.
---

# Screenshot

Clipboard image paste is unreliable in this user's environment (foot terminal on
Sway/Wayland). Screenshots taken with the `$mod+F7` hotkey are saved to a fixed
path instead of the clipboard:

`~/Pictures/screenshot.png`

When the user references "the screenshot" or asks you to look at something they
just captured, read this file directly with the Read tool rather than asking
them to paste it.

Note: this file is overwritten on every `$mod+F7` capture, so it always reflects
the most recent screenshot. The `Print` key still saves timestamped screenshots
into `~/Pictures` if a history is needed.

## Taking your own screenshot

You can also capture a screenshot yourself with `grim` (Sway/Wayland screenshot
tool) instead of waiting for the user to capture one — useful for verifying a
visual change (e.g. waybar/sway config edits) before reporting it done.

- Full screen: `grim /path/to/output.png`
- A specific region (e.g. just the waybar strip at the top of a 1920-wide
  output): `grim -g "0,0 1920x30" /path/to/output.png`
- Interactive region selection with `slurp` (only useful when a human is present
  to drag a selection — not usable non-interactively):
  `grim -g "$(slurp)" /path/to/output.png`
- `grim -o <output>` selects a specific monitor by name (from
  `swaymsg -t
  get_outputs`) and cannot be combined with `-g`.

## Capturing a specific app or workspace

`grim` alone has no concept of "app windows" — only full screen, a monitor, or a
manual rectangle. `~/.config/sway/screenshot-app.sh` closes that gap and never
switches workspaces or touches focus, so it never interrupts the user.

**`app` mode captures true background windows.** It uses `wayshot` (specifically
the `wayshot-git` AUR package — the stable 1.5.0 release lacks
`--list-toplevels-json` and can't be scripted), which captures a window's actual
compositor buffer via the `ext-image-copy-capture` Wayland protocol. This works
regardless of occlusion or which workspace the window is on — no workspace
switch, no flicker, nothing visible happens at all.

**`workspace` mode has no equivalent** — workspaces aren't toplevels, so there's
no off-screen capture protocol for them. It only works when the target workspace
is already visible (via `grim -g` on its rect) and errors out otherwise rather
than switching to it; ask the user to switch to it themselves if you need that
view.

Every capture requires a `<name>` tag (e.g. your agent/task id) as the second
argument. It picks the default output file (`~/Pictures/screenshot-<name>.png`)
so parallel agents never collide on the same path — pick something unique to
you, not a generic name like `screenshot`.

- `~/.config/sway/screenshot-app.sh app my-task discord /path/to/out.png` —
  match by app_id, window class, or title substring (case-insensitive).
- `~/.config/sway/screenshot-app.sh workspace my-task 2 /path/to/out.png` —
  match by workspace name/number substring.
- `~/.config/sway/screenshot-app.sh list` — list current windows and workspaces
  to find the right query string (no name needed).
- Output path defaults to `~/Pictures/screenshot-<name>.png` if omitted.

Save to a scratch path (e.g. under `~/Pictures` or the scratchpad directory),
read it back with the Read tool to inspect it, and delete it afterward if it was
only for verification, not something the user asked to keep.

**GPU-accelerated windows (rviz2, gzclient/gz sim, anything OpenGL) can come
back solid black with `app` mode** — observed with `rviz2` shortly after launch.
Likely a `wayshot`/`ext-image-copy-capture` buffer-capture timing or compositing
quirk with GL surfaces, not a real empty window. If an `app`-mode capture of
such a window is solid black, retry once (the window may not have finished its
first real paint yet) and if it's still black, fall back to a full-screen `grim`
capture instead (crop/read the relevant region) rather than trusting the black
result as ground truth.
