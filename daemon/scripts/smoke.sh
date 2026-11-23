#!/bin/sh
# End-to-end smoke test for msmd: build the real binary, run it over TLS, and
# assert on the API's behaviour (auth, pairing, and the basic endpoints).
#
# Run from the daemon/ directory:  make smoke   (or: sh scripts/smoke.sh)
# Requires: go, curl. Exits non-zero on the first failed check.
#
# Set MSMD_SMOKE_LIVE=1 to also provision and boot a real Paper server (needs
# network access; not run in CI).
set -eu

PORT="${MSMD_SMOKE_PORT:-18443}"
BASE="https://127.0.0.1:$PORT"
WORK="$(mktemp -d)"
DATA="$WORK/data"
BIN="$WORK/msmd$(go env GOEXE)"
LOG="$WORK/msmd.log"
PID=""

cleanup() {
  [ -n "$PID" ] && kill "$PID" 2>/dev/null || true
  rm -rf "$WORK" 2>/dev/null || true
}
trap cleanup EXIT

fail() {
  echo "FAIL: $1" >&2
  echo "--- daemon log ---" >&2
  cat "$LOG" >&2 2>/dev/null || true
  exit 1
}

# status METHOD PATH [curl args...] -> prints the HTTP status code
status() {
  method="$1"
  path="$2"
  shift 2
  curl -sk -o /dev/null -w '%{http_code}' -X "$method" "$@" "$BASE$path"
}

expect_status() {
  want="$1"
  desc="$2"
  shift 2
  got="$(status "$@")"
  [ "$got" = "$want" ] || fail "$desc: expected HTTP $want, got $got"
  echo "ok   $desc (HTTP $got)"
}

expect_contains() {
  desc="$1"
  needle="$2"
  body="$3"
  case "$body" in
    *"$needle"*) echo "ok   $desc" ;;
    *) fail "$desc: response did not contain '$needle': $body" ;;
  esac
}

echo "== build"
CGO_ENABLED=0 go build -o "$BIN" ./cmd/msmd

echo "== start"
"$BIN" -data "$DATA" -addr "127.0.0.1:$PORT" >"$LOG" 2>&1 &
PID=$!

i=0
until curl -sk "$BASE/v1/health" >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -gt 50 ] && fail "daemon did not start listening on $BASE"
  kill -0 "$PID" 2>/dev/null || fail "daemon exited during startup"
  sleep 0.2
done

[ -s "$DATA/token" ] || fail "token file was not created in the data dir"
TOKEN="$(cat "$DATA/token")"
AUTH="Authorization: Bearer $TOKEN"

echo "== health"
expect_status 200 "health needs no auth" GET /v1/health

echo "== authentication"
expect_status 401 "servers without a token" GET /v1/servers
expect_status 401 "servers with a wrong token" GET /v1/servers -H "Authorization: Bearer wrong-token"
expect_status 401 "info without a token" GET /v1/info
expect_status 401 "create without a token" POST /v1/servers -H "Content-Type: application/json" -d '{}'
expect_status 200 "servers with the token" GET /v1/servers -H "$AUTH"
expect_status 200 "info with the token" GET /v1/info -H "$AUTH"

echo "== pairing"
expect_status 401 "pair with a wrong token" POST /v1/pair -H "Content-Type: application/json" -d '{"token":"wrong-token"}'
PAIR="$(curl -sk -X POST -H "Content-Type: application/json" -d "{\"token\":\"$TOKEN\"}" "$BASE/v1/pair")"
expect_contains "pair returns the API token" '"apiToken"' "$PAIR"

echo "== API"
SERVERS="$(curl -sk -H "$AUTH" "$BASE/v1/servers")"
[ "$(printf '%s' "$SERVERS" | tr -d ' \n\r')" = "[]" ] || fail "fresh daemon should list no servers, got: $SERVERS"
echo "ok   fresh daemon lists no servers"
expect_status 404 "unknown server id" GET /v1/servers/does-not-exist -H "$AUTH"

echo "== input validation"
# All of these are rejected before anything is downloaded or written.
JSON="Content-Type: application/json"
expect_status 400 "unknown engine" POST /v1/servers -H "$AUTH" -H "$JSON" \
  -d '{"name":"v1","minecraftVersion":"1.21.4","modLoader":"spigot","modLoaderVersion":"1"}'
expect_status 400 "paper build that is not a number" POST /v1/servers -H "$AUTH" -H "$JSON" \
  -d '{"name":"v2","minecraftVersion":"1.21.4","modLoader":"paper","modLoaderVersion":"../../x"}'
expect_status 400 "paper on a pre-release version" POST /v1/servers -H "$AUTH" -H "$JSON" \
  -d '{"name":"v3","minecraftVersion":"1.21.4-rc1","modLoader":"paper","modLoaderVersion":"12"}'
expect_status 400 "malformed memory setting" POST /v1/servers -H "$AUTH" -H "$JSON" \
  -d '{"name":"v4","minecraftVersion":"1.21.4","maxRam":"4G -XX:Evil"}'
expect_status 400 "minimum memory above maximum" POST /v1/servers -H "$AUTH" -H "$JSON" \
  -d '{"name":"v5","minecraftVersion":"1.21.4","minRam":"8G","maxRam":"4G"}'
expect_status 400 "unknown JVM profile" POST /v1/servers -H "$AUTH" -H "$JSON" \
  -d '{"name":"v6","minecraftVersion":"1.21.4","jvmProfile":"zgc"}'
expect_status 400 "unknown server software" GET /v1/software/spigot/versions -H "$AUTH"
expect_status 400 "paper builds for a malformed version" GET "/v1/loaders/paper/versions?mc=abc" -H "$AUTH"
expect_status 401 "software versions without a token" GET /v1/software/paper/versions
SERVERS="$(curl -sk -H "$AUTH" "$BASE/v1/servers")"
[ "$(printf '%s' "$SERVERS" | tr -d ' \n\r')" = "[]" ] || fail "rejected requests must not create servers, got: $SERVERS"
echo "ok   rejected requests created nothing"

# Opt-in: provision and boot a real Paper server. Needs network access and a
# few minutes (the daemon installs a JDK if the host has no suitable one).
#   MSMD_SMOKE_LIVE=1 sh scripts/smoke.sh
if [ -n "${MSMD_SMOKE_LIVE:-}" ]; then
  echo "== live Paper server"
  MC="${MSMD_SMOKE_MC:-1.21.11}"
  GAME_PORT="${MSMD_SMOKE_GAME_PORT:-25598}"

  VERSIONS="$(curl -sk -H "$AUTH" "$BASE/v1/software/paper/versions")"
  expect_contains "paper lists Minecraft $MC" "\"$MC\"" "$VERSIONS"

  BUILDS="$(curl -sk -H "$AUTH" "$BASE/v1/loaders/paper/versions?mc=$MC")"
  BUILD="$(printf '%s' "$BUILDS" | grep -o '"version":"[0-9]*","stable":true' | head -n 1 | grep -o '[0-9][0-9]*' | head -n 1)"
  [ -n "$BUILD" ] || fail "no stable Paper build for $MC: $BUILDS"
  echo "ok   newest stable Paper $MC build is $BUILD"

  CREATED="$(curl -sk -X POST -H "$AUTH" -H "$JSON" "$BASE/v1/servers" \
    -d "{\"name\":\"smoke-paper\",\"minecraftVersion\":\"$MC\",\"modLoader\":\"paper\",\"modLoaderVersion\":\"$BUILD\",\"port\":$GAME_PORT,\"minRam\":\"1G\",\"maxRam\":\"2G\",\"jvmProfile\":\"aikar\"}")"
  SID="$(printf '%s' "$CREATED" | grep -o '"id":"[0-9a-f]*"' | head -n 1 | grep -o '[0-9a-f]\{32\}')"
  [ -n "$SID" ] || fail "create did not return an id: $CREATED"
  expect_contains "the JVM profile is stored" '"jvmProfile":"aikar"' "$CREATED"

  # wait_log NEEDLE SECONDS -> waits until the server log contains NEEDLE
  wait_log() {
    waited=0
    while [ "$waited" -lt "$2" ]; do
      LOGS="$(curl -sk -H "$AUTH" "$BASE/v1/servers/$SID/logs")"
      case "$LOGS" in
        *"Provisioning failed"*) fail "provisioning failed: $LOGS" ;;
        *"$1"*) return 0 ;;
      esac
      waited=$((waited + 2))
      sleep 2
    done
    fail "timed out waiting for '$1' in the server log: $LOGS"
  }

  wait_log "Provisioning complete" 300
  expect_contains "paper jar checksum verified" "sha256 checksum OK" "$LOGS"
  expect_status 202 "start the server" POST "/v1/servers/$SID/start" -H "$AUTH"
  wait_log "Done (" 360
  echo "ok   Paper finished booting"
  expect_status 202 "stop the server" POST "/v1/servers/$SID/stop" -H "$AUTH"
  waited=0
  until curl -sk -H "$AUTH" "$BASE/v1/servers/$SID" | grep -q '"status":"stopped"'; do
    waited=$((waited + 1))
    [ "$waited" -lt 60 ] || fail "server did not stop"
    sleep 1
  done
  echo "ok   server stopped cleanly"
  expect_status 204 "delete the server" DELETE "/v1/servers/$SID" -H "$AUTH"
fi

echo "== TLS"
# The listener must be TLS-only: a plain-HTTP request must not get a 2xx answer.
PLAIN="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/v1/health" 2>/dev/null || true)"
case "$PLAIN" in
  2*) fail "daemon answered plain HTTP with $PLAIN" ;;
  *) echo "ok   plain HTTP is not served (got ${PLAIN:-no response})" ;;
esac

echo "SMOKE_OK"
