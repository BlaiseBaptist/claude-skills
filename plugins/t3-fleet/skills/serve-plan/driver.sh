#!/usr/bin/env bash
# serve-plan driver: publish a static HTML dir at
# https://<host>.tail2b35ba.ts.net/<slug>/ via a path-scoped `tailscale serve`
# mount, alongside T3 Code's own `/` mount (which it never touches).
#
#   driver.sh up <slug> [dir]     start http.server + mount the path, print URL
#   driver.sh check <slug>        assert the URL serves, and that `/` still does
#   driver.sh shot <slug> [out]   headless-chromium screenshot of the served page
#   driver.sh list                every mount on this box, ours marked
#   driver.sh down <slug>         unmount, kill the server, delete the dir
#   driver.sh demo                full up/check/shot/down on a throwaway slug
set -uo pipefail

ROOT="${T3_HTML_PLAN_ROOT:-$HOME/.t3-html-plan}"
HOST="$(tailscale status --json 2>/dev/null | sed -n 's/.*"DNSName": *"\([^".]*\)\..*/\1/p' | head -1)"
: "${HOST:=$(hostname)}"
BASE="https://${HOST}.tail2b35ba.ts.net"

die() { echo "driver: $*" >&2; exit 1; }

# Ports: 8100-8199, skipping anything already listening. Do not assume a
# free port -- other services squat in this range (8125 on war).
free_port() {
  local p
  for p in $(seq 8100 8199); do
    ss -ltn "sport = :$p" 2>/dev/null | grep -q LISTEN || { echo "$p"; return 0; }
  done
  return 1
}

state() { echo "$ROOT/$1/.serve-state"; }

cmd_up() {
  local slug="${1:?usage: up <slug> [dir]}" src="${2:-}"
  [[ "$slug" =~ ^[A-Za-z0-9._-]+$ ]] || die "slug must be [A-Za-z0-9._-]+ (it becomes a URL path)"
  local dir="$ROOT/$slug"
  if [ -n "$src" ]; then mkdir -p "$dir" && cp -r "$src"/. "$dir"/; else mkdir -p "$dir"; fi
  [ -f "$dir/index.html" ] || { rmdir "$dir" 2>/dev/null; die "no $dir/index.html -- write the page first"; }
  [ -f "$(state "$slug")" ] && die "$slug is already up; 'down' it first"

  tailscale serve status 2>/dev/null | grep -qE "^\|-- /$slug " && die "/$slug is already mounted by something else"
  local port; port="$(free_port)" || die "no free port in 8100-8199"

  nohup python3 -m http.server "$port" --bind 127.0.0.1 --directory "$dir" \
    >"$dir/.http.log" 2>&1 &
  local pid=$!
  sleep 1
  kill -0 "$pid" 2>/dev/null || { cat "$dir/.http.log" >&2; die "http.server died"; }

  tailscale serve --bg --set-path="/$slug" "$port" >/dev/null || {
    kill "$pid"; die "tailscale serve failed (is tailscaled up? are HTTPS certs enabled?)"; }
  printf 'port=%s\npid=%s\n' "$port" "$pid" > "$(state "$slug")"
  echo "$BASE/$slug/"
}

cmd_check() {
  local slug="${1:?usage: check <slug>}" rc=0
  # shellcheck disable=SC1090
  . "$(state "$slug")" 2>/dev/null || die "$slug is not up"
  local a b c
  a=$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/")
  b=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/$slug/")
  c=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/")
  echo "loopback :$port      $a"
  echo "tailnet  /$slug      $b"
  echo "T3 Code  /           $c   (must stay 200 -- we share this front door)"
  [ "$a" = 200 ] && [ "$b" = 200 ] || rc=1
  [ "$c" = 200 ] || { echo "WARNING: T3 Code's / mount is not answering" >&2; rc=1; }
  return $rc
}

# Chromium comes from the playwright cache; the version dir moves, so glob it.
chromium() {
  local c
  for c in "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux64/chrome \
           "$HOME"/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell; do
    [ -x "$c" ] && { echo "$c"; return 0; }
  done
  return 1
}

cmd_shot() {
  local slug="${1:?usage: shot <slug> [out.png]}"
  local out="${2:-/tmp/$slug.png}" ch
  ch="$(chromium)" || die "no chromium; install with: npx -y playwright@latest install chromium"
  "$ch" --headless --disable-gpu --no-sandbox --hide-scrollbars \
    --window-size=1280,900 --screenshot="$out" "$BASE/$slug/" >/dev/null 2>&1
  [ -s "$out" ] || die "screenshot failed"
  echo "$out"
}

cmd_list() {
  tailscale serve status
  echo "--- $ROOT ---"
  local d n=0
  for d in "$ROOT"/*/; do
    [ -d "$d" ] || break
    n=$((n+1))
    if [ -f "$d/.serve-state" ]; then
      echo "up      $(basename "$d")  $(tr '\n' ' ' < "$d/.serve-state")"
    else
      # A reboot kills http.server but leaves the dir. These are stale
      # plans from earlier sessions -- `down <slug>` clears one.
      echo "orphan  $(basename "$d")  (no server; dir left behind)"
    fi
  done
  [ "$n" = 0 ] && echo "(none)"
  return 0
}

cmd_down() {
  local slug="${1:?usage: down <slug>}"
  # NEVER `tailscale serve --https=443 off` -- tailscale suggests that on mount
  # and it would take down T3 Code's `/` for the whole box.
  tailscale serve --set-path="/$slug" off 2>/dev/null
  # shellcheck disable=SC1090
  if . "$(state "$slug")" 2>/dev/null; then kill "$pid" 2>/dev/null; fi
  rm -rf "${ROOT:?}/$slug"
  tailscale serve status | sed -n '1,20p'
}

cmd_demo() {
  local slug="serve-plan-demo-$(head -c3 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  local dir="$ROOT/$slug"
  mkdir -p "$dir"
  echo 'body{font:16px system-ui;color:#b00}' > "$dir/style.css"
  cat > "$dir/index.html" <<'HTML'
<!doctype html><meta charset=utf-8><title>serve-plan demo</title>
<link rel=stylesheet href="style.css">
<h1>serve-plan demo</h1><p>marker: PROBE-OK</p>
HTML
  echo "== up ==";    cmd_up "$slug"    || { cmd_down "$slug" >/dev/null; die "up failed"; }
  echo "== check =="; cmd_check "$slug" || { cmd_down "$slug" >/dev/null; die "check failed"; }
  echo "== asset (relative href, proves the /$slug prefix is stripped) =="
  curl -sS -o /dev/null -w "style.css %{http_code}\n" "$BASE/$slug/style.css"
  echo "== shot ==";  cmd_shot "$slug" "/tmp/$slug.png"
  echo "== down ==";  cmd_down "$slug"
  echo "demo OK"
}

case "${1:-}" in
  up|check|shot|list|down|demo) c="$1"; shift; "cmd_$c" "$@";;
  *) sed -n '2,12p' "$0"; exit 1;;
esac
