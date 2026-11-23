#!/bin/sh
# End-to-end smoke test for msmd: build the real binary, run it over TLS, and
# assert on the API's behaviour (auth, pairing, and the basic endpoints).
#
# Run from the daemon/ directory:  make smoke   (or: sh scripts/smoke.sh)
# Requires: go, curl. Exits non-zero on the first failed check.
#
# Set MSMD_SMOKE_LIVE=1 to also provision and boot a real Paper server (needs
# network access; not run in CI). Set MSMD_SMOKE_BIN to test an msmd binary
# that is already built instead of building one (then go is not needed).
set -eu

PORT="${MSMD_SMOKE_PORT:-18443}"
BASE="https://127.0.0.1:$PORT"
WORK="$(mktemp -d)"
DATA="$WORK/data"
BIN="$WORK/msmd"
[ -n "${MSMD_SMOKE_BIN:-}" ] || BIN="$WORK/msmd$(go env GOEXE)"
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

if [ -n "${MSMD_SMOKE_BIN:-}" ]; then
  echo "== using $MSMD_SMOKE_BIN"
  BIN="$MSMD_SMOKE_BIN"
else
  echo "== build"
  CGO_ENABLED=0 go build -o "$BIN" ./cmd/msmd
fi

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
expect_status 400 "modpack from a host other than Modrinth" POST /v1/servers -H "$AUTH" -H "$JSON" \
  -d '{"name":"x","minecraftVersion":"1.21.4","modpack":{"source":"modrinth","projectId":"p","versionId":"v","name":"n","mrpackUrl":"https://example.com/pack.mrpack"}}'
expect_status 400 "modpack over plain http" POST /v1/servers -H "$AUTH" -H "$JSON" \
  -d '{"name":"x","minecraftVersion":"1.21.4","modpack":{"source":"modrinth","projectId":"p","versionId":"v","name":"n","mrpackUrl":"http://cdn.modrinth.com/data/pack.mrpack"}}'
expect_status 400 "malformed memory setting" POST /v1/servers -H "$AUTH" -H "$JSON" \
  -d '{"name":"v4","minecraftVersion":"1.21.4","maxRam":"4G -XX:Evil"}'
expect_status 400 "minimum memory above maximum" POST /v1/servers -H "$AUTH" -H "$JSON" \
  -d '{"name":"v5","minecraftVersion":"1.21.4","minRam":"8G","maxRam":"4G"}'
expect_status 400 "unknown JVM profile" POST /v1/servers -H "$AUTH" -H "$JSON" \
  -d '{"name":"v6","minecraftVersion":"1.21.4","jvmProfile":"zgc"}'
expect_status 400 "unknown server software" GET /v1/software/spigot/versions -H "$AUTH"
expect_status 400 "paper builds for a malformed version" GET "/v1/loaders/paper/versions?mc=abc" -H "$AUTH"
expect_status 401 "software versions without a token" GET /v1/software/paper/versions
expect_status 401 "backups without a token" GET /v1/servers/does-not-exist/backups
expect_status 401 "backup without a token" POST /v1/servers/does-not-exist/backups
expect_status 404 "backups of an unknown server" GET /v1/servers/does-not-exist/backups -H "$AUTH"
expect_status 404 "backup of an unknown server" POST /v1/servers/does-not-exist/backups -H "$AUTH"
expect_status 404 "restore on an unknown server" POST /v1/servers/does-not-exist/backups/20260101-000000-manual/restore -H "$AUTH"
expect_status 404 "delete of a backup of an unknown server" DELETE /v1/servers/does-not-exist/backups/20260101-000000-manual -H "$AUTH"
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

echo "== shutdown"
# Stopping msmd must stop its servers first: each one is told to save and exit,
# and only the ones that ignore that are killed. Git Bash has no real SIGTERM
# (kill ends the process outright), so this part runs on Linux and macOS only.
case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*)
    echo "skip shutdown checks (no SIGTERM on this platform)"
    ;;
  *)
    kill -TERM "$PID"
    wait "$PID" || fail "idle daemon did not exit cleanly on SIGTERM"
    PID=""
    echo "ok   idle daemon exits cleanly on SIGTERM"

    # Two stand-ins for a Minecraft server, started through a fake java: one
    # saves and exits on "stop", the other ignores everything.
    FAKEJAVA="$WORK/fakejava"
    cat >"$FAKEJAVA" <<'FAKE'
#!/bin/sh
echo $$ >pid
echo "Fake server up"
if [ -f stubborn ]; then
  trap '' TERM INT
  while :; do sleep 1; done
fi
while read -r line; do
  case "$line" in
    save-off) echo "[12:00:00] [Server thread/INFO]: Automatic saving is now disabled" ;;
    "save-all flush") echo "[12:00:00] [Server thread/INFO]: Saved the game" ;;
    save-on) : >saving-on ;;
    stop)
      : >saved
      exit 0
      ;;
  esac
done
FAKE
    chmod +x "$FAKEJAVA"
    GOOD="00000000000000000000000000000001"
    BAD="00000000000000000000000000000002"
    GONE="00000000000000000000000000000003"
    COLD="00000000000000000000000000000004"
    mkdir -p "$WORK/good" "$WORK/bad" "$WORK/gone" "$WORK/cold/world" "$WORK/cold/logs"
    : >"$WORK/cold/server.jar"
    echo "LEVEL-1" >"$WORK/cold/world/level.dat"
    echo "log" >"$WORK/cold/logs/latest.log"
    : >"$WORK/good/server.jar"
    : >"$WORK/bad/server.jar"
    : >"$WORK/gone/server.jar"
    : >"$WORK/bad/stubborn"
    NOW="2026-01-01T00:00:00Z"
    cat >"$DATA/servers.json" <<SEED
[
  {"id":"$GOOD","name":"good","dir":"$WORK/good","minecraftVersion":"1.21.4","port":25565,"minRam":"1G","maxRam":"1G","autoStart":true,"createdAt":"$NOW","updatedAt":"$NOW"},
  {"id":"$BAD","name":"bad","dir":"$WORK/bad","minecraftVersion":"1.21.4","port":25566,"minRam":"1G","maxRam":"1G","autoStart":true,"createdAt":"$NOW","updatedAt":"$NOW"},
  {"id":"$GONE","name":"gone","dir":"$WORK/gone","minecraftVersion":"1.21.4","port":25567,"minRam":"1G","maxRam":"1G","createdAt":"$NOW","updatedAt":"$NOW"},
  {"id":"$COLD","name":"cold","dir":"$WORK/cold","minecraftVersion":"1.21.4","port":25568,"minRam":"1G","maxRam":"1G","createdAt":"$NOW","updatedAt":"$NOW"}
]
SEED

    MSMD_JAVA="$FAKEJAVA" MSMD_STOP_GRACE=3s "$BIN" -data "$DATA" -addr "127.0.0.1:$PORT" >>"$LOG" 2>&1 &
    PID=$!
    i=0
    until curl -sk "$BASE/v1/health" >/dev/null 2>&1; do
      i=$((i + 1))
      [ "$i" -gt 50 ] && fail "daemon did not come back up"
      sleep 0.2
    done
    for sid in "$GOOD" "$BAD" "$GONE"; do
      expect_status 202 "start fake server $sid" POST "/v1/servers/$sid/start" -H "$AUTH"
    done
    i=0
    until [ -s "$WORK/good/pid" ] && [ -s "$WORK/bad/pid" ] && [ -s "$WORK/gone/pid" ]; do
      i=$((i + 1))
      [ "$i" -gt 50 ] && fail "fake servers did not start"
      sleep 0.2
    done
    # Settings and restart, while a server is up.
    expect_status 401 "update without a token" PATCH "/v1/servers/$GOOD" -H "$JSON" -d '{"restartSchedule":"04:30"}'
    expect_status 400 "malformed restart schedule" PATCH "/v1/servers/$GOOD" -H "$AUTH" -H "$JSON" -d '{"restartSchedule":"4:30"}'
    expect_status 400 "update of a read-only field" PATCH "/v1/servers/$GOOD" -H "$AUTH" -H "$JSON" -d '{"dir":"/tmp"}'
    expect_status 404 "update of an unknown server" PATCH /v1/servers/does-not-exist -H "$AUTH" -H "$JSON" -d '{}'
    UPDATED="$(curl -sk -X PATCH -H "$AUTH" -H "$JSON" -d '{"restartSchedule":"04:30"}' "$BASE/v1/servers/$GOOD")"
    expect_contains "the restart schedule is stored" '"restartSchedule":"04:30"' "$UPDATED"
    UPDATED="$(curl -sk -X PATCH -H "$AUTH" -H "$JSON" -d '{"restartSchedule":null}' "$BASE/v1/servers/$GOOD")"
    case "$UPDATED" in
      *restartSchedule*) fail "null did not clear the restart schedule: $UPDATED" ;;
      *'"id"'*) echo "ok   null clears the restart schedule" ;;
      *) fail "unexpected answer to the update: $UPDATED" ;;
    esac
    expect_contains "info reports the host time zone" '"timeZone"' "$(curl -sk -H "$AUTH" "$BASE/v1/info")"
    expect_status 400 "malformed backup schedule" PATCH "/v1/servers/$GOOD" -H "$AUTH" -H "$JSON" -d '{"backupSchedule":"3:30"}'
    expect_status 400 "number of backups to keep out of range" PATCH "/v1/servers/$GOOD" -H "$AUTH" -H "$JSON" -d '{"backupKeep":0}'
    expect_status 400 "the last scheduled backup cannot be written" PATCH "/v1/servers/$GOOD" -H "$AUTH" -H "$JSON" -d '{"backupLastRun":null}'
    UPDATED="$(curl -sk -X PATCH -H "$AUTH" -H "$JSON" -d '{"backupSchedule":"03:30","backupKeep":3}' "$BASE/v1/servers/$GOOD")"
    expect_contains "the backup schedule is stored" '"backupSchedule":"03:30"' "$UPDATED"
    expect_contains "the number of backups to keep is stored" '"backupKeep":3' "$UPDATED"
    UPDATED="$(curl -sk -X PATCH -H "$AUTH" -H "$JSON" -d '{"backupSchedule":null}' "$BASE/v1/servers/$GOOD")"
    case "$UPDATED" in
      *backupSchedule*) fail "null did not clear the backup schedule: $UPDATED" ;;
      *'"backupKeep":3'*) echo "ok   null clears the backup schedule and nothing else" ;;
      *) fail "unexpected answer to the update: $UPDATED" ;;
    esac

    OLD_PID="$(cat "$WORK/good/pid")"
    expect_status 404 "restart of an unknown server" POST /v1/servers/does-not-exist/restart -H "$AUTH"
    expect_status 202 "restart a running server" POST "/v1/servers/$GOOD/restart" -H "$AUTH"
    i=0
    until [ "$(cat "$WORK/good/pid" 2>/dev/null)" != "$OLD_PID" ] && [ -s "$WORK/good/pid" ]; do
      i=$((i + 1))
      [ "$i" -gt 100 ] && fail "the server was not restarted"
      sleep 0.2
    done
    [ -f "$WORK/good/saved" ] || fail "the restart did not stop the server cleanly first"
    rm -f "$WORK/good/saved"
    if kill -0 "$OLD_PID" 2>/dev/null; then fail "the old server process survived the restart"; fi
    echo "ok   restart replaces the server process after a clean stop"

    # Deleting a running server answers at once; the server stops first and is
    # removed when its process is gone.
    GONE_PID="$(cat "$WORK/gone/pid")"
    expect_status 202 "delete a running server" DELETE "/v1/servers/$GONE" -H "$AUTH"
    i=0
    until [ "$(status GET "/v1/servers/$GONE" -H "$AUTH")" = "404" ]; do
      i=$((i + 1))
      [ "$i" -gt 100 ] && fail "the running server was never deleted"
      sleep 0.2
    done
    if kill -0 "$GONE_PID" 2>/dev/null; then fail "the deleted server is still running"; fi
    [ ! -e "$WORK/gone" ] || fail "the files of the deleted server are still there"
    echo "ok   a running server is stopped, then deleted with its files"
    expect_status 404 "delete of a server that is gone" DELETE "/v1/servers/$GONE" -H "$AUTH"

    # Backups. A stopped server: back up, change the files, restore.
    # wait_operation <server> <operation> <kind> <label>
    wait_operation() {
      i=0
      while :; do
        VIEW="$(curl -sk -H "$AUTH" "$BASE/v1/servers/$1")"
        case "$VIEW" in *"\"lastOperation\":{\"id\":\"$2\""*) break ;; esac
        i=$((i + 1))
        [ "$i" -gt 100 ] && fail "$4 never finished: $VIEW"
        sleep 0.2
      done
      case "$VIEW" in
        *"\"lastOperation\":{\"id\":\"$2\",\"kind\":\"$3\",\"ok\":true"*) echo "ok   $4" ;;
        *) fail "$4 failed: $VIEW" ;;
      esac
    }
    operation_id() { printf '%s' "$1" | sed -n 's/.*"operationId":"\([0-9a-f]*\)".*/\1/p'; }
    backup_id() { printf '%s' "$1" | sed -n 's/.*"id":"\([0-9]\{8\}-[0-9]\{6\}-manual\)".*/\1/p'; }

    STARTED="$(curl -sk -X POST -H "$AUTH" "$BASE/v1/servers/$COLD/backups")"
    OP="$(operation_id "$STARTED")"
    [ -n "$OP" ] || fail "starting a backup did not return an operation id: $STARTED"
    wait_operation "$COLD" "$OP" backup "backup of a stopped server"
    LIST="$(curl -sk -H "$AUTH" "$BASE/v1/servers/$COLD/backups")"
    BID="$(backup_id "$LIST")"
    [ -n "$BID" ] || fail "the backup is not listed: $LIST"
    expect_contains "the backup says the server was stopped" '"whileRunning":false' "$LIST"
    expect_contains "the backup left the logs out" '"fileCount":2' "$LIST"
    [ -f "$DATA/backups/$COLD/$BID.zip" ] || fail "the archive is not in the backups folder"

    echo "LEVEL-2" >"$WORK/cold/world/level.dat"
    echo "extra" >"$WORK/cold/world/extra.dat"
    expect_status 400 "restore with a malformed backup id" POST "/v1/servers/$COLD/backups/..%2F$BID/restore" -H "$AUTH"
    expect_status 404 "restore of a backup that does not exist" POST "/v1/servers/$COLD/backups/20200101-000000-manual/restore" -H "$AUTH"
    expect_status 400 "restore with a malformed body" POST "/v1/servers/$COLD/backups/$BID/restore" -H "$AUTH" -H "$JSON" -d '{'
    STARTED="$(curl -sk -X POST -H "$AUTH" "$BASE/v1/servers/$COLD/backups/$BID/restore")"
    OP="$(operation_id "$STARTED")"
    [ -n "$OP" ] || fail "starting a restore did not return an operation id: $STARTED"
    wait_operation "$COLD" "$OP" restore "restore of a stopped server"
    [ "$(cat "$WORK/cold/world/level.dat")" = "LEVEL-1" ] || fail "the restore did not bring the file back"
    [ ! -e "$WORK/cold/world/extra.dat" ] || fail "a file that is not in the backup survived the restore"
    [ "$(cat "$WORK/cold/logs/latest.log")" = "log" ] || fail "the restore touched the logs"
    if [ -e "$WORK/cold.restore-stage" ] || [ -e "$WORK/cold.restore-aside" ]; then fail "the restore left folders behind"; fi
    echo "ok   the restore replaced the files and left the logs alone"
    expect_contains "the restore backed the current files up first" '-pre-restore"' "$(curl -sk -H "$AUTH" "$BASE/v1/servers/$COLD/backups")"
    expect_status 204 "delete a backup" DELETE "/v1/servers/$COLD/backups/$BID" -H "$AUTH"
    expect_status 404 "delete a backup that is gone" DELETE "/v1/servers/$COLD/backups/$BID" -H "$AUTH"
    expect_status 400 "delete with a malformed backup id" DELETE "/v1/servers/$COLD/backups/nope" -H "$AUTH"

    # A running server: saving is paused for the copy and turned back on.
    STARTED="$(curl -sk -X POST -H "$AUTH" "$BASE/v1/servers/$GOOD/backups")"
    OP="$(operation_id "$STARTED")"
    [ -n "$OP" ] || fail "starting a backup of a running server did not return an operation id: $STARTED"
    wait_operation "$GOOD" "$OP" backup "backup of a running server"
    LIST="$(curl -sk -H "$AUTH" "$BASE/v1/servers/$GOOD/backups")"
    expect_contains "the backup says the server was running" '"whileRunning":true' "$LIST"
    i=0
    until [ -f "$WORK/good/saving-on" ]; do
      i=$((i + 1))
      [ "$i" -gt 50 ] && fail "saving was not turned back on after the backup"
      sleep 0.2
    done
    echo "ok   saving is turned back on after the backup"
    expect_status 409 "restore onto a running server" POST "/v1/servers/$GOOD/backups/$(backup_id "$LIST")/restore" -H "$AUTH"

    # A scheduled backup, through the real scheduler: the stopped server is
    # set to be backed up at the next minute on the host's clock.
    HOST_TIME="$(curl -sk -H "$AUTH" "$BASE/v1/info" | sed -n 's/.*"time":"[0-9-]*T\([0-9][0-9]:[0-9][0-9]:[0-9][0-9]\).*/\1/p')"
    [ -n "$HOST_TIME" ] || fail "info does not report the host time"
    HH="${HOST_TIME%%:*}"; REST="${HOST_TIME#*:}"; MM="${REST%%:*}"; SS="${REST#*:}"
    AHEAD=1
    # Too close to the minute, the scheduler might first look after it.
    [ "${SS#0}" -ge 30 ] && AHEAD=2
    TOTAL=$(( (${HH#0} * 60 + ${MM#0} + AHEAD) % 1440 ))
    AT="$(printf '%02d:%02d' $((TOTAL / 60)) $((TOTAL % 60)))"
    UPDATED="$(curl -sk -X PATCH -H "$AUTH" -H "$JSON" -d "{\"backupSchedule\":\"$AT\",\"backupKeep\":1}" "$BASE/v1/servers/$COLD")"
    expect_contains "a backup is scheduled for $AT" "\"backupSchedule\":\"$AT\"" "$UPDATED"
    i=0
    while :; do
      VIEW="$(curl -sk -H "$AUTH" "$BASE/v1/servers/$COLD")"
      case "$VIEW" in *'"backupLastRun"'*) break ;; esac
      i=$((i + 1))
      [ "$i" -gt 170 ] && fail "the scheduled backup ($AT, host time was $HOST_TIME) never ran: $VIEW"
      sleep 1
    done
    expect_contains "the scheduled backup is recorded as made" '"outcome":"ok"' "$VIEW"
    LIST="$(curl -sk -H "$AUTH" "$BASE/v1/servers/$COLD/backups")"
    expect_contains "the scheduled backup is listed" '-scheduled"' "$LIST"
    expect_contains "it is listed as scheduled" '"kind":"scheduled"' "$LIST"
    expect_contains "backups of other kinds are kept" '"kind":"pre-restore"' "$LIST"
    curl -sk -X PATCH -H "$AUTH" -H "$JSON" -d '{"backupSchedule":null}' "$BASE/v1/servers/$COLD" >/dev/null

    # Deleting a server takes its backups along.
    expect_status 204 "delete the stopped server" DELETE "/v1/servers/$COLD" -H "$AUTH"
    [ ! -e "$DATA/backups/$COLD" ] || fail "the backups of the deleted server are still there"
    echo "ok   deleting a server deletes its backups"

    GOOD_PID="$(cat "$WORK/good/pid")"
    BAD_PID="$(cat "$WORK/bad/pid")"

    kill -TERM "$PID"
    wait "$PID" || fail "daemon did not exit cleanly on SIGTERM with servers running"
    PID=""
    [ -f "$WORK/good/saved" ] || fail "the server that obeys stop was not given the chance to save"
    echo "ok   a running server is asked to stop and saves before msmd exits"
    if kill -0 "$GOOD_PID" 2>/dev/null || kill -0 "$BAD_PID" 2>/dev/null; then
      kill -9 "$GOOD_PID" "$BAD_PID" 2>/dev/null || true
      fail "a server process outlived msmd"
    fi
    echo "ok   no server process outlives msmd (the one ignoring stop was killed)"
    grep -q "stopping 2 running server" "$LOG" || fail "shutdown did not report the servers it stopped"
    ;;
esac

echo "SMOKE_OK"
