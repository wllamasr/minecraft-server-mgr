// Package config handles the daemon's runtime configuration and the on-disk
// material it manages on first run: a self-signed TLS certificate and the API
// token used to authenticate the manager.
package config

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"time"
)

// DefaultStopGrace is how long a server gets to shut down unless
// MSMD_STOP_GRACE says otherwise. Saving a large world takes a while.
const DefaultStopGrace = 2 * time.Minute

// Config is the resolved runtime configuration.
type Config struct {
	Addr        string // listen address, e.g. ":8443"
	DataDir     string // base directory for state (certs, token, db, servers)
	ServersRoot string // where server instances live
	BackupsRoot string // where backups are kept, one folder per server
	CertPath    string
	KeyPath     string
	TokenPath   string
	StorePath   string // servers.json
	JavaPath    string // optional fixed java binary; empty means auto-manage
	JavaDir     string // where auto-installed JDKs are kept
	// StopGrace is how long a server gets to save and exit after "stop" before
	// it is killed.
	StopGrace time.Duration
}

// Load resolves configuration from explicit values, environment, and defaults.
func Load(addr, dataDir string) (Config, error) {
	if addr == "" {
		addr = envOr("MSMD_ADDR", ":8443")
	}
	if dataDir == "" {
		dataDir = envOr("MSMD_DATA", "./msmd-data")
	}
	abs, err := filepath.Abs(dataDir)
	if err != nil {
		return Config{}, err
	}

	cfg := Config{
		Addr:        addr,
		DataDir:     abs,
		ServersRoot: envOr("MSMD_SERVERS_ROOT", filepath.Join(abs, "servers")),
		BackupsRoot: envOr("MSMD_BACKUPS_ROOT", filepath.Join(abs, "backups")),
		CertPath:    filepath.Join(abs, "cert.pem"),
		KeyPath:     filepath.Join(abs, "key.pem"),
		TokenPath:   filepath.Join(abs, "token"),
		StorePath:   filepath.Join(abs, "servers.json"),
		JavaPath:    os.Getenv("MSMD_JAVA"), // empty => auto-detect/-install
		JavaDir:     envOr("MSMD_JAVA_DIR", filepath.Join(abs, "jdks")),
		StopGrace:   DefaultStopGrace,
	}
	if v := os.Getenv("MSMD_STOP_GRACE"); v != "" {
		d, err := time.ParseDuration(v)
		if err != nil || d < time.Second {
			return Config{}, fmt.Errorf("MSMD_STOP_GRACE must be a duration of at least 1s, like 90s or 5m (got %q)", v)
		}
		cfg.StopGrace = d
	}
	return cfg, nil
}

// EnsureDirs creates the data, servers, backups, and JDK directories.
func (c Config) EnsureDirs() error {
	for _, d := range []string{c.DataDir, c.ServersRoot, c.BackupsRoot, c.JavaDir} {
		if err := os.MkdirAll(d, 0o750); err != nil {
			return err
		}
	}
	return nil
}

// EnsureToken returns the existing API token or generates and persists a new one.
// The boolean result reports whether a new token was created.
func (c Config) EnsureToken() (token string, created bool, err error) {
	if b, e := os.ReadFile(c.TokenPath); e == nil && len(b) > 0 {
		return string(b), false, nil
	}
	raw := make([]byte, 32)
	if _, err = rand.Read(raw); err != nil {
		return "", false, err
	}
	token = hex.EncodeToString(raw)
	if err = os.WriteFile(c.TokenPath, []byte(token), 0o600); err != nil {
		return "", false, err
	}
	return token, true, nil
}

// RotateToken generates and persists a fresh API token, invalidating the old one.
func (c Config) RotateToken() (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	token := hex.EncodeToString(raw)
	if err := os.WriteFile(c.TokenPath, []byte(token), 0o600); err != nil {
		return "", err
	}
	return token, nil
}

// EnsureCert generates a self-signed certificate/key pair on first run.
// The manager pins the certificate by fingerprint (trust on first use), so the
// SANs are only a convenience for local tooling.
func (c Config) EnsureCert() error {
	if fileExists(c.CertPath) && fileExists(c.KeyPath) {
		return nil
	}

	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}

	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return err
	}

	tmpl := x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: "msmd"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().AddDate(10, 0, 0),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		DNSNames:              []string{"localhost"},
		IPAddresses:           localIPs(),
	}

	der, err := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &priv.PublicKey, priv)
	if err != nil {
		return err
	}

	certOut, err := os.OpenFile(c.CertPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	defer certOut.Close()
	if err := pem.Encode(certOut, &pem.Block{Type: "CERTIFICATE", Bytes: der}); err != nil {
		return err
	}

	keyBytes, err := x509.MarshalECPrivateKey(priv)
	if err != nil {
		return err
	}
	keyOut, err := os.OpenFile(c.KeyPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	defer keyOut.Close()
	return pem.Encode(keyOut, &pem.Block{Type: "EC PRIVATE KEY", Bytes: keyBytes})
}

// Fingerprint returns the hex SHA-256 of the DER certificate, matching what the
// manager pins during pairing.
func (c Config) Fingerprint() (string, error) {
	pemBytes, err := os.ReadFile(c.CertPath)
	if err != nil {
		return "", err
	}
	block, _ := pem.Decode(pemBytes)
	if block == nil {
		return "", fmt.Errorf("could not decode certificate PEM")
	}
	sum := sha256.Sum256(block.Bytes)
	return hex.EncodeToString(sum[:]), nil
}

func localIPs() []net.IP {
	ips := []net.IP{net.IPv4(127, 0, 0, 1), net.IPv6loopback}
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return ips
	}
	for _, a := range addrs {
		if ipnet, ok := a.(*net.IPNet); ok && !ipnet.IP.IsLoopback() {
			ips = append(ips, ipnet.IP)
		}
	}
	return ips
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
