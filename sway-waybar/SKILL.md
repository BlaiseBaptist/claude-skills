---
name: sway-waybar
description: Use whenever you need to reload waybar or sway after editing config/CSS files in ~/.config/waybar or ~/.config/sway - reload with `swaymsg reload`, not `pkill -SIGUSR2 waybar` or `killall waybar`.
---

# Sway / Waybar reload

This user runs Sway with Waybar. After editing waybar config (`config.jsonc`,
`style.css`) or sway config, reload with:

```
swaymsg reload
```

Do NOT use `pkill -SIGUSR2 waybar`, `killall waybar`, or manually restarting
the waybar process — `swaymsg reload` is the correct way to reload both sway
and waybar config in this setup and avoids leaving stray/duplicate waybar
processes.
