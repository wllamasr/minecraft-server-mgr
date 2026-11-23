#!/bin/sh
# End-to-end smoke test for msmd: build the real binary, run it over TLS, and
# assert on the API's behaviour (auth, pairing, and the basic endpoints).
#
# Run from the daemon/ directory:  make smoke   (or: sh scripts/smoke.sh)
# Requires: go, curl. Exits non-zero on the first failed check.
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

echo "== TLS"
# The listener must be TLS-only: a plain-HTTP request must not get a 2xx answer.
PLAIN="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/v1/health" 2>/dev/null || true)"
case "$PLAIN" in
  2*) fail "daemon answered plain HTTP with $PLAIN" ;;
  *) echo "ok   plain HTTP is not served (got ${PLAIN:-no response})" ;;
esac

echo "SMOKE_OK"
