package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"mailer-go/backend/shared/crypto"
	"mailer-go/backend/smtp/pkg/api"
	"mailer-go/backend/smtp/pkg/config"
	"mailer-go/backend/smtp/pkg/domains"
	"mailer-go/backend/smtp/pkg/hub"
	"mailer-go/backend/smtp/pkg/outbound"
	"mailer-go/backend/smtp/pkg/smtpserver"
	"mailer-go/backend/smtp/pkg/spool"
)

func main() {
	log.Println("==================================================")
	log.Println("Starting SMTP Edge Worker & Relay Service...")
	log.Println("==================================================")

	cfg := config.Load()

	encryptor := crypto.NewEncryptor(cfg.AESPassphrase)
	log.Println("[SECURITY] AES-256-GCM encryption initialized.")

	spoolMgr, err := spool.NewSpoolManager(cfg.MaxRAMMB, cfg.MaxDiskMB, cfg.MaxDiskMessages, cfg.SQLitePath)
	if err != nil {
		log.Fatalf("[FATAL] Failed to initialize spool manager: %v", err)
	}
	defer spoolMgr.Close()
	log.Printf("[SPOOL] Spool active: Max RAM=%d MB, Max Disk=%d MB (max %d msgs), SQLite=%s",
		cfg.MaxRAMMB, cfg.MaxDiskMB, cfg.MaxDiskMessages, cfg.SQLitePath)

	domainMgr, err := domains.NewDomainManager(spoolMgr.DB())
	if err != nil {
		log.Fatalf("[FATAL] Failed to initialize local domain manager: %v", err)
	}
	log.Printf("[DOMAINS] Local domain manager active: %d cached domain(s)", len(domainMgr.ListDomains()))

	wsHub := hub.NewWSHub(encryptor, spoolMgr)

	outboundSender := outbound.NewSender(domainMgr, cfg.ServerHostname, cfg.OutboundDialTimeoutSec, cfg.OutboundSMTPPort, !cfg.IsProduction())

	apiServer := api.NewAPIServer(cfg, wsHub, spoolMgr, outboundSender, encryptor, domainMgr)
	mux := http.NewServeMux()
	apiServer.RegisterRoutes(mux)

	httpServer := &http.Server{
		Addr:              ":" + cfg.HTTPPort,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      120 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	go func() {
		log.Printf("[API] HTTP & WebSocket server listening on :%s", cfg.HTTPPort)
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("[FATAL] HTTP server error: %v", err)
		}
	}()

	smtpServer := smtpserver.NewSMTPServer(
		":"+cfg.SMTPPort,
		cfg.ServerHostname,
		wsHub,
		domainMgr,
		cfg.Debug,
		cfg.MaxMessageMB,
		cfg.MaxRecipients,
		cfg.SMTPReadTimeoutSec,
		cfg.SMTPWriteTimeoutSec,
		cfg.TLSCertFile,
		cfg.TLSKeyFile,
	)
	go func() {
		if err := smtpServer.ListenAndServe(); err != nil {
			log.Printf("[SMTP] SMTP server stopped: %v", err)
		}
	}()

	var submissionServer *smtpserver.SMTPServer
	if cfg.SMTPSubmissionPort != "" && cfg.SMTPSubmissionPort != cfg.SMTPPort {
		submissionServer = smtpserver.NewSMTPServer(
			":"+cfg.SMTPSubmissionPort,
			cfg.ServerHostname,
			wsHub,
			domainMgr,
			cfg.Debug,
			cfg.MaxMessageMB,
			cfg.MaxRecipients,
			cfg.SMTPReadTimeoutSec,
			cfg.SMTPWriteTimeoutSec,
			cfg.TLSCertFile,
			cfg.TLSKeyFile,
		)
		go func() {
			if err := submissionServer.ListenAndServe(); err != nil {
				log.Printf("[SMTP SUBMISSION] Submission server stopped: %v", err)
			}
		}()
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop

	log.Println("\n[SHUTDOWN] Shutting down SMTP and API servers gracefully...")
	_ = smtpServer.Close()
	if submissionServer != nil {
		_ = submissionServer.Close()
	}

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer shutdownCancel()
	_ = httpServer.Shutdown(shutdownCtx)

	fmt.Println("SMTP service stopped.")
}
