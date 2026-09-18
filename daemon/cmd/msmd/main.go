// Command msmd is the Minecraft Server Manager daemon: an agent that runs on a
// host and manages Minecraft servers there on behalf of the desktop manager.
//
// Subcommands:
//
//	msmd serve            run the daemon (default)
//	msmd auth [--token]   print (or --rotate) the API token for pairing
//	msmd version          print the version
package main

import (
	"context"
	"crypto/tls"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/wllamasr/minecraft-server-mgr/daemon/internal/api"
	"github.com/wllamasr/minecraft-server-mgr/daemon/internal/config"
	"github.com/wllamasr/minecraft-server-mgr/daemon/internal/console"
	"github.com/wllamasr/minecraft-server-mgr/daemon/internal/server"
	"github.com/wllamasr/minecraft-server-mgr/daemon/internal/store"
)

func main() {
	args := os.Args[1:]
	cmd := "serve"
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		cmd, args = args[0], args[1:]
	}

	switch cmd {
	case "serve":
		runServe(args)
	case "auth":
		runAuth(args)
	case "version", "--version", "-version":
		fmt.Printf("msmd %s\n", api.AgentVersion)
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\nusage:\n  msmd serve\n  msmd auth [--token] [--rotate] [--json]\n  msmd version\n", cmd)
		os.Exit(2)
	}
}

// runAuth prints (or rotates) the API token used to pair the manager.
func runAuth(args []string) {
	fs := flag.NewFlagSet("auth", flag.ExitOnError)
	dataDir := fs.String("data", "", "data directory (default ./msmd-data or $MSMD_DATA)")
	rotate := fs.Bool("rotate", false, "generate a new token, invalidating the old one")
	rawOnly := fs.Bool("token", false, "print only the raw token (scriptable)")
	asJSON := fs.Bool("json", false, "print token and fingerprint as JSON")
	_ = fs.Parse(args)

	cfg, err := config.Load("", *dataDir)
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	if err := cfg.EnsureDirs(); err != nil {
		log.Fatalf("data dir: %v", err)
	}
	if err := cfg.EnsureCert(); err != nil {
		log.Fatalf("tls certificate: %v", err)
	}

	var token string
	if *rotate {
		token, err = cfg.RotateToken()
	} else {
		token, _, err = cfg.EnsureToken()
	}
	if err != nil {
		log.Fatalf("token: %v", err)
	}
	fpr, err := cfg.Fingerprint()
	if err != nil {
		log.Fatalf("fingerprint: %v", err)
	}

	switch {
	case *rawOnly:
		fmt.Println(token)
	case *asJSON:
		fmt.Printf("{\"token\":%q,\"fingerprint\":%q}\n", token, fpr)
	default:
		fmt.Println("Pairing token (paste into the manager's Add Remote Host):")
		fmt.Printf("  %s\n\n", token)
		fmt.Printf("Certificate fingerprint (SHA-256): %s\n", fpr)
	}
}

// runServe starts the daemon.
func runServe(args []string) {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	addr := fs.String("addr", "", "listen address (default :8443 or $MSMD_ADDR)")
	dataDir := fs.String("data", "", "data directory (default ./msmd-data or $MSMD_DATA)")
	_ = fs.Parse(args)

	cfg, err := config.Load(*addr, *dataDir)
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	if err := cfg.EnsureDirs(); err != nil {
		log.Fatalf("data dir: %v", err)
	}
	if err := cfg.EnsureCert(); err != nil {
		log.Fatalf("tls certificate: %v", err)
	}
	token, created, err := cfg.EnsureToken()
	if err != nil {
		log.Fatalf("token: %v", err)
	}
	fingerprint, err := cfg.Fingerprint()
	if err != nil {
		log.Fatalf("fingerprint: %v", err)
	}

	st, err := store.Open(cfg.StorePath)
	if err != nil {
		log.Fatalf("store: %v", err)
	}

	hub := console.New()
	mgr := server.NewManager(cfg, st, hub)
	apiServer := api.New(cfg, mgr, token, fingerprint)

	httpServer := &http.Server{
		Addr:      cfg.Addr,
		Handler:   apiServer.Handler(),
		TLSConfig: &tls.Config{MinVersion: tls.VersionTLS12},
	}

	log.Printf("msmd %s starting", api.AgentVersion)
	log.Printf("  listen:       https://%s", cfg.Addr)
	log.Printf("  data dir:     %s", cfg.DataDir)
	log.Printf("  servers root: %s", cfg.ServersRoot)
	log.Printf("  java dir:     %s", cfg.JavaDir)
	log.Printf("  cert SHA-256: %s", fingerprint)
	if created {
		log.Printf("")
		log.Printf("  ┌───────────────────────────────────────────────────────────────")
		log.Printf("  │ PAIRING TOKEN (needed once, in the manager's Add Remote Host):")
		log.Printf("  │   %s", token)
		log.Printf("  └───────────────────────────────────────────────────────────────")
		log.Printf("  (regenerate anytime with: msmd auth --rotate)")
		log.Printf("")
	} else {
		log.Printf("  pairing token: run 'msmd auth' to print it")
	}

	idle := make(chan struct{})
	go func() {
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
		<-sig
		log.Printf("shutting down...")
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(ctx)
		close(idle)
	}()

	if err := httpServer.ListenAndServeTLS(cfg.CertPath, cfg.KeyPath); err != nil && err != http.ErrServerClosed {
		log.Fatalf("server: %v", err)
	}
	<-idle
	log.Printf("stopped")
}
