# Testing the daemon on a real VM

This walks through running `msmd` on a separate Linux virtual machine and
managing it from the desktop app — the realistic "remote host" path: its own IP,
a real network hop, and the systemd service. It also exercises the headline
feature: a **fresh VM with no Java** where the daemon installs one automatically.

We use **Multipass** (Canonical's one-command Ubuntu VMs). On Windows Pro it runs
on Hyper-V under the hood; on Home it can use VirtualBox. If you'd rather drive
Hyper-V by hand, see the note at the end — the daemon steps are identical.

## 0. Install Multipass (once)

```bash
winget install Canonical.Multipass
```

Close and reopen your terminal afterwards so `multipass` is on PATH. (Or download
it from https://multipass.run.)

## 1. Build the Linux daemon binary (no Go needed on Windows)

We build the static binary inside a Go container — nothing to install on your PC:

```bash
docker run --rm -v "E:\code\minecraft-win-manager\daemon:/src" -w /src -e CGO_ENABLED=0 -e GOOS=linux -e GOARCH=amd64 golang:1.22 go build -o dist/msmd-linux-amd64 ./cmd/msmd
```

This produces `daemon/dist/msmd-linux-amd64`.

## 2. Create the VM

```bash
multipass launch 22.04 --name msmd-test --memory 4G --disk 10G
```

A fresh Ubuntu with **no Java installed** — exactly what we want to test the
auto-install.

## 3. Copy the binary + service files into the VM

```bash
multipass transfer daemon/dist/msmd-linux-amd64 msmd-test:/tmp/msmd
multipass transfer daemon/deploy/install.sh msmd-test:/tmp/install.sh
multipass transfer daemon/deploy/msmd.service msmd-test:/tmp/msmd.service
```

## 4. Install msmd as a systemd service

`install.sh` expects `msmd.service` next to it, so we put both in one folder:

```bash
multipass exec msmd-test -- sudo mkdir -p /tmp/deploy
multipass exec msmd-test -- sudo mv /tmp/install.sh /tmp/msmd.service /tmp/deploy/
multipass exec msmd-test -- sudo bash /tmp/deploy/install.sh /tmp/msmd
```

The installer creates the `msmd` user, installs the binary to
`/usr/local/bin/msmd`, writes the systemd unit, starts the service, and prints
the **pairing token**.

## 5. Get the host's IP and token

```bash
multipass info msmd-test | findstr IPv4
multipass exec msmd-test -- sudo cat /var/lib/msmd/token
```

Note the IPv4 address (e.g. `172.20.x.x`) and the token. You can regenerate the
token anytime with:

```bash
multipass exec msmd-test -- sudo -u msmd /usr/local/bin/msmd auth --rotate --token
```

## 6. Pair from the app

1. Run the app (`npm run dev`) and open **Remote Hosts** in the sidebar.
2. Click **Add Remote Host**:
   - **Address:** `https://<the-ipv4>:8443`
   - **Pairing token:** the token from step 5
3. Click **Pair**. The host appears with its info (agent version, OS, and —
   at first — *"Java: auto-install on first server"*).

## 7. See the magic: deploy a server on a Java-less VM

1. Select the host, click **Deploy Server**, pick a Minecraft version, RAM, and
   (optionally) a mod loader, then **Deploy**.
2. Open that server's **console**. You'll see the daemon:
   - detect there's no compatible Java,
   - download and install an Eclipse Temurin JDK,
   - download the server jar (and, if chosen, install the mod loader),
   - report the server ready.
3. **Start** the server and watch it boot in the console. Send a command
   (e.g. `list`) from the console box.

## Useful commands

```bash
# Follow the daemon's own logs
multipass exec msmd-test -- sudo journalctl -u msmd -f

# Service status
multipass exec msmd-test -- systemctl status msmd

# If you enabled a firewall, open the port
multipass exec msmd-test -- sudo ufw allow 8443/tcp

# Tear it all down when done
multipass delete msmd-test && multipass purge
```

## Troubleshooting

- **App can't reach the host:** confirm the IP with `multipass info`, and that the
  VM is `Running`. From Windows, `curl.exe -k https://<ip>:8443/v1/health` should
  return `{"status":"ok",...}`.
- **"certificate fingerprint mismatch":** you re-created the VM (new cert) but
  kept the old host entry. Remove the host in the app and add it again.
- **Java install is slow:** it downloads a full JDK (~180 MB) once, then caches it
  under `/var/lib/msmd/jdks` and reuses it for future servers.

## Doing it with Hyper-V by hand instead

If you prefer raw Hyper-V: create a Generation 2 VM, install Ubuntu Server from
its ISO, give it a network switch that's reachable from the host (an External
switch is simplest), then run steps 1–7 — copy the binary in with `scp` instead
of `multipass transfer`, and get the IP with `ip a` inside the VM. Everything
about the daemon is the same.
