#!/bin/sh
# End-to-end smoke test for msmd: build, run over TLS, and exercise the API.
# Intended to run inside a Go container (see daemon/README.md).
set -e

DATA=/tmp/msmd-smoke
rm -rf "$DATA"

go build -o /tmp/msmd ./cmd/msmd
/tmp/msmd -data "$DATA" -addr 127.0.0.1:8443 >/tmp/msmd.log 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true' EXIT

# Wait for the listener.
i=0
while ! curl -sk https://127.0.0.1:8443/v1/health >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -gt 30 ] && { echo "server did not start"; cat /tmp/msmd.log; exit 1; }
  sleep 0.3
done

TOKEN=$(cat "$DATA/token")

echo "=== startup log ==="
cat /tmp/msmd.log
echo
echo "=== GET /v1/health (no auth) ==="
curl -sk https://127.0.0.1:8443/v1/health
echo
echo "=== GET /v1/servers without token (expect 401) ==="
curl -sk -o /dev/null -w "http=%{http_code}\n" https://127.0.0.1:8443/v1/servers
echo "=== POST /v1/pair ==="
curl -sk -X POST -H "Content-Type: application/json" -d "{\"token\":\"$TOKEN\"}" https://127.0.0.1:8443/v1/pair
echo
echo "=== GET /v1/info (auth) ==="
curl -sk -H "Authorization: Bearer $TOKEN" https://127.0.0.1:8443/v1/info
echo
echo "=== GET /v1/servers (auth, expect []) ==="
curl -sk -H "Authorization: Bearer $TOKEN" https://127.0.0.1:8443/v1/servers
echo
echo "=== data dir contents ==="
ls -1 "$DATA"
echo "SMOKE_OK"
