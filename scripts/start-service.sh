#!/usr/bin/env bash
# Launch one model service with its secret injected, or refuse.
#
# ⚠️ THE REFUSAL IS THE POINT. This exists because the following correct-looking
# check exposed a GPU inference endpoint to the internet for four minutes:
#
#     if SERVICE_SECRET and secret != SERVICE_SECRET:
#         reject()
#
# The service had been started without the environment variable set, so the
# secret was "" and the whole check became a no-op. The code was right; the
# launch was wrong. A missing secret is a configuration error, and a service
# that reads it as "no authentication required" will eventually be started that
# way by someone in a hurry - so make it impossible to start that way at all.
#
# USAGE
#   bash scripts/start-service.sh <name>
#
# Configure with a .env file next to this repo (never commit it):
#   GPU_SERVICE_SECRET=...
#   TTS_CMD=/path/to/tts-venv/bin/python /path/to/tts_server.py
#   LIPSYNC_CMD=/path/to/lipsync-venv/bin/python -m uvicorn server:app --port 7894
set -uo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
NAME="${1:?usage: start-service.sh <name>}"

[ -f "$HERE/.env" ] && set -a && . "$HERE/.env" && set +a

: "${GPU_SERVICE_SECRET:?refusing to start: GPU_SERVICE_SECRET is not set. \
An empty secret turns the auth check into a no-op and publishes your GPU.}"

case "$NAME" in
  tts)     CMD="${TTS_CMD:?TTS_CMD not set}" ; URL="${TTS_URL:-http://127.0.0.1:7896}"
           PROBE=/tts ;;
  lipsync) CMD="${LIPSYNC_CMD:?LIPSYNC_CMD not set}" ; URL="${LIPSYNC_URL:-http://127.0.0.1:7894}"
           # ⚠️ NOT /tts. services/CONTRACT.md gives this service /speak and
           # /lipsync; probing /tts got a 404, which is neither 401 nor 403 nor
           # 000, so the case below fell through to "answered with no auth
           # header" and killed the service it had just started. The auth probe
           # has to hit a route the service actually serves or it tests nothing
           # and destroys everything.
           PROBE=/speak ;;
  *) echo "unknown service: $NAME"; exit 1 ;;
esac

echo "starting $NAME"
# shellcheck disable=SC2086
GPU_SERVICE_SECRET="$GPU_SERVICE_SECRET" $CMD &
PID=$!

# ⚠️ Verify our own work rather than assuming it. Wait for the port, then call
# the endpoint with NO auth header and require a rejection. If auth is open we
# would rather the launch fail loudly here than succeed quietly and stay open.
for _ in $(seq 1 60); do
  curl -s -o /dev/null -m 3 "$URL/health" && break
  kill -0 "$PID" 2>/dev/null || { echo "$NAME exited during startup"; exit 1; }
  sleep 2
done

# ⚠️ No `|| echo 000` here. curl already writes 000 to stdout on a connection
# failure AND exits non-zero, so the fallback appended a second one and CODE
# became the string "000000" - which matched no branch below and fell to the
# catch-all, reporting "ANSWERED 000000 WITH NO AUTH HEADER". It still failed
# safe, but the operator got nonsense and the unreachable branch was dead.
CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 10 -X POST "$URL$PROBE" \
        -H 'Content-Type: application/json' -d '{"text":"x"}' 2>/dev/null)"
CODE="${CODE:-000}"
case "$CODE" in
  401|403) echo "$NAME up, auth verified (unauthenticated request got $CODE)" ;;
  000)     echo "!! $NAME up but $PROBE is unreachable - auth NOT verified. Stopping it."
           kill "$PID" 2>/dev/null; exit 1 ;;
  404)     echo "!! $NAME does not serve $PROBE. Auth not verified; see CONTRACT.md. Stopping it."
           kill "$PID" 2>/dev/null; exit 1 ;;
  *)       echo "!! $NAME ANSWERED $CODE WITH NO AUTH HEADER. Stopping it."
           kill "$PID" 2>/dev/null; exit 1 ;;
esac
wait "$PID"
