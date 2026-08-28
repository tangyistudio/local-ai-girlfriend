#!/usr/bin/env bash
# Keep the GPU services alive, without eating the card when they cannot start.
#
# ⚠️ THE NAIVE VERSION OF THIS IS A FORK BOMB WITH A TIMER.
#
# "restart it when /health does not answer" has a fatal interaction with a full
# GPU:
#
#   1. the service cannot start, because there is not enough VRAM
#   2. it begins loading anyway - now holding VRAM, port not open yet
#   3. the watchdog sees no /health and starts another one
#   4. go to 1
#
# Observed on the source project at 38 processes, 22 of 23 GB consumed, fully
# deadlocked, every process waiting for memory the others were holding.
#
# Two things prevent it, and you need both:
#
#   - CHECK WHETHER THE PROCESS EXISTS before starting another. A process that
#     is running but not answering means "still loading", not "dead".
#   - BACK OFF on repeated failures.
#
# ⚠️ And a third, from docs/08-ops.md: counting processes will lie to you twice.
# Matching a keyword against command lines counts the query you just typed;
# a service launched through a venv shows a launcher AND a server, which looks
# like two instances. Match on the full command and resolve parents.
#
# USAGE
#   GPU_SERVICE_SECRET=... bash scripts/watchdog.sh
#   touch  <STATE_DIR>/pause     # stop acting, keep logging - do this before
#                                # any batch job that needs the whole card
set -uo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="${WATCHDOG_STATE_DIR:-$HERE/.watchdog}"
INTERVAL="${WATCHDOG_INTERVAL:-20}"
mkdir -p "$STATE_DIR"

# service name | health url | start command
# Fill these in for your own stack; nothing here assumes a particular model.
SERVICES="${WATCHDOG_SERVICES:-$HERE/services/services.conf}"
[ -f "$SERVICES" ] || { echo "no service list at $SERVICES"; exit 1; }

log () { printf '%s  %s\n' "$(date +%H:%M:%S)" "$*" | tee -a "$STATE_DIR/watchdog.log"; }

# Single-instance lock. Two watchdogs racing to restart the same service is the
# same failure as one watchdog with no process check.
LOCK="$STATE_DIR/lock"
if [ -e "$LOCK" ] && kill -0 "$(cat "$LOCK" 2>/dev/null)" 2>/dev/null; then
  echo "another watchdog is running (pid $(cat "$LOCK"))"; exit 0
fi
echo $$ > "$LOCK"
trap 'rm -f "$LOCK"' EXIT

log "watchdog up, interval ${INTERVAL}s, state in $STATE_DIR"

while true; do
  if [ -e "$STATE_DIR/pause" ]; then
    log "paused (remove $STATE_DIR/pause to resume)"
    sleep "$INTERVAL"; continue
  fi

  while IFS='|' read -r name url start; do
    case "$name" in ''|\#*) continue ;; esac
    name="$(echo "$name" | xargs)"; url="$(echo "$url" | xargs)"; start="$(echo "$start" | xargs)"

    code="$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$url" 2>/dev/null || echo 000)"

    # ⚠️ 200 is not readiness. Ask the service whether its model is loaded, and
    # treat "up but not loaded" as healthy-and-still-starting rather than dead.
    if [ "$code" = "200" ]; then
      loaded="$(curl -s -m 5 "$url" 2>/dev/null | grep -o '"model_loaded"[: ]*true' || true)"
      if [ -n "$loaded" ]; then
        rm -f "$STATE_DIR/$name.fails"
      else
        log "$name: up, model still loading - not restarting"
      fi
      continue
    fi

    # Not answering. Before concluding it is dead, look for the process.
    if pgrep -f "$start" >/dev/null 2>&1; then
      log "$name: not answering but the process exists - still loading, leaving alone"
      continue
    fi

    fails=$(( $(cat "$STATE_DIR/$name.fails" 2>/dev/null || echo 0) + 1 ))
    echo "$fails" > "$STATE_DIR/$name.fails"

    # Exponential backoff, capped. Without this, a service that cannot start
    # because the card is full gets retried forever and holds more of it each
    # time.
    # ⚠️ CAP THE SHIFT, not just the result. `fails` increments on every poll,
    # not on every restart, so at INTERVAL=20 it reaches 60 within 20 minutes.
    # `1 << 59` overflows a signed 64-bit shell integer to a NEGATIVE number,
    # the `-gt 600` cap then never fires, and the backoff this block exists to
    # provide silently becomes no backoff at all - the fork bomb with a timer
    # the header of this file warns about, arriving exactly when a service has
    # been failing long enough to matter.
    shift_n=$(( fails - 1 ))
    [ "$shift_n" -gt 16 ] && shift_n=16
    backoff=$(( INTERVAL * (1 << shift_n) ))
    [ "$backoff" -gt 600 ] && backoff=600
    if [ "$fails" -gt 1 ]; then
      last=$(cat "$STATE_DIR/$name.last" 2>/dev/null || echo 0)
      now=$(date +%s)
      if [ $(( now - last )) -lt "$backoff" ]; then
        log "$name: down, backing off (${fails} failures, waiting ${backoff}s)"
        continue
      fi
    fi

    log "$name: down and no process - starting (failure #$fails)"
    date +%s > "$STATE_DIR/$name.last"
    # shellcheck disable=SC2086
    nohup $start >>"$STATE_DIR/$name.out" 2>&1 &
  done < "$SERVICES"

  sleep "$INTERVAL"
done
