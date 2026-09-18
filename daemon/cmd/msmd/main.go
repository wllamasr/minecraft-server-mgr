// Command msmd is the Minecraft Server Manager daemon: an agent that runs on a
// host and manages Minecraft servers there on behalf of the desktop manager.
package main

import (
	"context"
	"crypto/tls"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/wllamasr/minecraft-server-mgr/daemon/internal/api"
	"github.com/wllamasr/minecraft-server-mgr/daemon/internal/config"
	"github.com/wllamasr/minecraft-server-mgr/daemon/internal/console"
	"github.com/wllamasr/minecraft-server-mgr/daemon/internal/server"
	"github.com/wllamasr/minecraft-server-mgr/daemon/internal/store"
)

func main() {
	addr := flag.String("addr", "", "listen address (default :8443 or $MSMD_ADDR)")
	dataDir := flag.String("data", "", "data directory (default ./msmd-data or $MSMD_DATA)")
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()

	if *showVersion {
		log.Printf("msmd %s", api.AgentVersion)
		return
	}

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
		Addr:    cfg.Addr,
		Handler: apiServer.Handler(),
		TLSConfig: &tls.Config{
			MinVersion: tls.VersionTLS12,
		},
	}

	log.Printf("msmd %s starting", api.AgentVersion)
	log.Printf("  listen:       https://%s", cfg.Addr)
	log.Printf("  data dir:     %s", cfg.DataDir)
	log.Printf("  servers root: %s", cfg.ServersRoot)
	log.Printf("  cert SHA-256: %s", fingerprint)
	if created {
		log.Printf("")
		log.Printf("  ┌───────────────────────────────────────────────────────────────")
		log.Printf("  │ PAIRING TOKEN (needed once, in the manager's Add Remote Host):")
		log.Printf("  │   %s", token)
		log.Printf("  └───────────────────────────────────────────────────────────────")
		log.Printf("")
	} else {
		log.Printf("  pairing token: (existing — see %s)", cfg.TokenPath)
	}

	// Graceful shutdown.
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
