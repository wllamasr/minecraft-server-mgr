#!/usr/bin/env bash
#
# Install msmd as a systemd service on a Linux host.
#
#   sudo ./install.sh /path/to/msmd-linux-amd64
#
# Creates the msmd user + data dir, installs the binary and unit, starts the
# service, and prints the pairing token so you can add the host in the manager.
set -euo pipefail

BINARY_SRC="${1:-./msmd}"
BIN_DEST="/usr/local/bin/msmd"
DATA_DIR="/var/lib/msmd"
UNIT_SRC="$(dirname "$0")/msmd.service"
UNIT_DEST="/etc/systemd/system/msmd.service"

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run as root (sudo)." >&2
  exit 1
fi
if [ ! -f "$BINARY_SRC" ]; then
  echo "Binary not found: $BINARY_SRC" >&2
  echo "Build it with 'make cross' (or 'make build') first." >&2
  exit 1
fi

echo "==> Creating msmd system user"
id -u msmd >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin msmd

echo "==> Installing binary to $BIN_DEST"
install -m 0755 "$BINARY_SRC" "$BIN_DEST"

echo "==> Preparing data dir $DATA_DIR"
mkdir -p "$DATA_DIR"
chown -R msmd:msmd "$DATA_DIR"

echo "==> Installing systemd unit"
install -m 0644 "$UNIT_SRC" "$UNIT_DEST"
systemctl daemon-reload
systemctl enable --now msmd

echo "==> Waiting for first start..."
sleep 2
echo
echo "Pairing token (add this host in the manager):"
echo "  $(cat "$DATA_DIR/token" 2>/dev/null || echo '<check: journalctl -u msmd>')"
echo
echo "Certificate fingerprint (journalctl -u msmd | grep SHA-256):"
journalctl -u msmd --no-pager 2>/dev/null | grep -m1 "SHA-256" || true
echo
echo "Service status: systemctl status msmd"
echo "Logs:           journalctl -u msmd -f"
