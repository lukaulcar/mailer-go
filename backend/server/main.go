package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	netmail "net/mail"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"mailer-go/backend/server/pkg/api"
	"mailer-go/backend/server/pkg/config"
	"mailer-go/backend/server/pkg/db"
	"mailer-go/backend/server/pkg/dnschecker"
	"mailer-go/backend/server/pkg/livehub"
	"mailer-go/backend/server/pkg/relayclient"
	"mailer-go/backend/server/pkg/storage"
	"mailer-go/backend/server/pkg/store"
	"mailer-go/backend/server/pkg/syncpusher"
	"mailer-go/backend/server/pkg/usermanager"
	"mailer-go/backend/shared/crypto"
	"mailer-go/backend/shared/emailparser"
	"mailer-go/backend/shared/models"
)

func main() {
	log.Println("==================================================")
	log.Println("Starting Central Control Plane Backend...")
	log.Println("==================================================")

	cfg := config.Load()

	database, err := db.New(cfg.CentralDBPath)
	if err != nil {
		log.Fatalf("[FATAL] Failed to initialize Central SQLite DB: %v", err)
	}
	defer database.Close()
	log.Printf("[DB] Central Control Plane Database active: %s", cfg.CentralDBPath)

	userMgr, err := usermanager.New(cfg.CentralDBPath, cfg.BaseUsersDir, cfg.AdminEmail, cfg.Mode)
	if err != nil {
		log.Fatalf("[FATAL] Failed to initialize user manager: %v", err)
	}
	defer userMgr.Close()
	log.Printf("[USERS] Multi-tenant user manager active at: %s (Mode: %s, SelfHosted: %t)", cfg.BaseUsersDir, cfg.Mode, cfg.SelfHosted)
	if err := userMgr.SyncAllUserDomainsToCentralDB(database); err != nil {
		log.Printf("[USERS WARNING] Failed to sync user domains to central db: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	encryptor := crypto.NewEncryptor(cfg.AESPassphrase)
	relayClient := relayclient.NewRelayClient(cfg, encryptor)

	syncPusher := syncpusher.NewSyncPusher(database, relayClient)
	log.Println("[SYNC] Central SyncPusher initialized for pushing domain state to SMTP edge service.")

	relayClient.SetOnConnect(func() {
		log.Println("[RELAY CLIENT] Connected to SMTP relay. Pushing current domain sync state...")
		syncPusher.TriggerPush()
	})

	syncInterval := time.Duration(cfg.DomainSyncIntervalSec) * time.Second
	syncPusher.StartPeriodicPush(ctx, syncInterval)

	syncPusher.TriggerPush()

	dnsChecker := dnschecker.NewDNSChecker(
		database,
		cfg.ServerHostname,
		cfg.DNSFailThreshold,
		cfg.DNSRateLimitSeconds,
		cfg.DNSResolver,
		cfg.DNSTimeoutSeconds,
		func(domain *models.Domain, isNowActive bool) {
			if isNowActive {
				log.Printf("[DNS CHECK] Domain %s is now verified/active.", domain.Name)
			} else {
				log.Printf("[DNS CHECK] Domain %s is now invalid/inactive.", domain.Name)
			}
			if uid, err := userMgr.GetUserIDByDomain(domain.Name); err == nil && uid != "" {
				if udb, err := userMgr.GetUserDB(uid); err == nil {
					_ = udb.UpsertDomain(domain)
				}
			}
			syncPusher.TriggerPush()
		},
	)

	checkInterval := time.Duration(cfg.DNSCheckIntervalMinutes) * time.Minute
	dnsChecker.StartBackgroundWorker(ctx, checkInterval)

	mailStore := store.NewMailStore()

	localStorage, err := storage.NewStorage(cfg.StoragePath)
	if err != nil {
		log.Fatalf("[FATAL] Failed to initialize local storage: %v", err)
	}
	log.Printf("[STORAGE] Local disk storage active at: %s", cfg.StoragePath)

	liveHub := livehub.NewLiveHub()
	liveHub.SetAllowedOrigins(cfg.CORSAllowedOrigins)
	log.Println("[LIVE HUB] Real-time live quota and event WebSocket hub active on /ws/live")

	relayClient.StartWSListener(ctx, func(mail *models.MailMessage) {
		status := "UNVERIFIED"
		if mail.Verification != nil && mail.Verification.IsVerified {
			status = "VERIFIED"
		}

		if mail.Raw != "" {
			parsed := emailparser.ParseEmail([]byte(mail.Raw))
			if parsed.TextBody != "" {
				mail.Body = parsed.TextBody
			}
			if parsed.HTMLBody != "" {
				mail.BodyHTML = parsed.HTMLBody
			}
			if len(parsed.Attachments) > 0 {
				mail.Attachments = parsed.Attachments
			}
		} else if mail.BodyHTML == "" && emailparser.IsMultipartOrEncoded(mail.Body) {
			textBody, htmlBody := emailparser.ParseBody(mail.Body, "")
			if textBody != "" {
				mail.Body = textBody
			}
			mail.BodyHTML = htmlBody
		}

		log.Printf("[SERVER] Processing incoming live email %s (From: %s, Subject: %s) [%s]",
			mail.ID, mail.From, mail.Subject, status)
		mailStore.Add(mail)

		for _, recipient := range mail.To {
			cleanRecipient := strings.ToLower(strings.TrimSpace(recipient))
			if parsed, err := netmail.ParseAddress(cleanRecipient); err == nil && parsed.Address != "" {
				cleanRecipient = strings.ToLower(strings.TrimSpace(parsed.Address))
			} else {
				cleanRecipient = strings.Trim(cleanRecipient, "<> ")
			}

			targetDB := database
			targetStorage := localStorage
			parts := strings.Split(cleanRecipient, "@")
			if len(parts) == 2 {
				domain := parts[1]
				if userID, err := userMgr.GetUserIDByDomain(domain); err == nil && userID != "" {
					if udb, err := userMgr.GetUserDB(userID); err == nil {
						targetDB = udb
					}
					if ustore, err := userMgr.GetUserStorage(userID); err == nil {
						targetStorage = ustore
					}
				}
			}

			boxes, err := targetDB.FindDeliveryMailboxes(cleanRecipient)
			if err != nil || len(boxes) == 0 {
				log.Printf("[SERVER] No local destination mailbox found for recipient <%s>", cleanRecipient)
				continue
			}

			for _, mb := range boxes {
				if mb.Kind == models.MailboxKindSendOnly {
					log.Printf("[SERVER] Recipient <%s> is send-only — discarding incoming payload (no storage)", mb.Address)
					continue
				}

				if cfg.IsLive() {
					var recipientPlan = 0
					if len(parts) == 2 {
						domain := parts[1]
						if uid, err := userMgr.GetUserIDByDomain(domain); err == nil && uid != "" {
							if u, err := userMgr.GetUserByID(uid); err == nil && u != nil {
								recipientPlan = u.Plan
							}
						}
					}
					if limit := mb.EffectiveQuotaBytes(recipientPlan, true); limit > 0 {
						if mb.UsedBytes+mail.SizeBytes > limit {
							log.Printf("[QUOTA EXCEEDED] Mailbox <%s> exceeded storage limit (%d + %d > %d bytes). Dropping incoming message.", mb.Address, mb.UsedBytes, mail.SizeBytes, limit)
							continue
						}
					}
				}

				rawPath, err := targetStorage.SaveRawMessage(mb.Address, mail.ID, []byte(mail.Raw))
				if err != nil {
					log.Printf("[STORAGE WARNING] Failed to write raw email to disk: %v", err)
				}

				var savedAttachments []*models.Attachment
				for _, att := range mail.Attachments {
					if len(att.Data) > 0 {
						savedAtt, err := targetStorage.SaveAttachment(mail.ID, mb.Address, att.Filename, att.ContentType, att.Data)
						if err == nil {
							savedAtt.ContentID = att.ContentID
							savedAtt.IsInline = att.IsInline
							savedAttachments = append(savedAttachments, savedAtt)
						} else {
							savedAttachments = append(savedAttachments, att)
						}
					} else {
						savedAttachments = append(savedAttachments, att)
					}
				}

				dateStr := mail.CreatedAt.UTC().Format(time.RFC3339)
				storedMsg := &models.StoredMessage{
					ID:          mail.ID,
					Mailbox:     mb.Address,
					Folder:      "inbox",
					From:        mail.From,
					To:          recipient,
					Subject:     mail.Subject,
					Body:        mail.Body,
					BodyHTML:    mail.BodyHTML,
					Attachments: savedAttachments,
					RawPath:     rawPath,
					SizeBytes:   mail.SizeBytes,
					Date:        dateStr,
					Read:        false,
					Starred:     false,
					CreatedAt:   mail.CreatedAt.Unix(),
				}

				if err := targetDB.CreateMessage(storedMsg); err != nil {
					log.Printf("[DB ERROR] Failed to store incoming email in DB for %s: %v", mb.Address, err)
					continue
				}

				if updatedMb, err := targetDB.GetMailbox(mb.Address); err == nil {
					liveHub.NotifyMailboxUsage(mb.Address, updatedMb.UsedBytes, updatedMb.UsedMb)
				}
				liveHub.NotifyMessageReceived(mb.Address, storedMsg)
			}
		}
	})

	apiServer := api.NewAPIServer(mailStore, relayClient, database, dnsChecker, syncPusher, localStorage, liveHub, userMgr, cfg.SelfHosted, cfg.ServerHostname, cfg.Mode, cfg.AdminEmail)
	mux := http.NewServeMux()
	apiServer.RegisterRoutes(mux)

	corsHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		allowedOrigin := strings.TrimSpace(cfg.CORSAllowedOrigins)

		if origin != "" {
			isAllowed := false
			if allowedOrigin == "" || allowedOrigin == "*" {
				isAllowed = true
			} else {
				for _, o := range strings.Split(allowedOrigin, ",") {
					if strings.EqualFold(strings.TrimSpace(o), origin) {
						isAllowed = true
						break
					}
				}
			}

			if isAllowed {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Access-Control-Allow-Credentials", "true")
				w.Header().Add("Vary", "Origin")
			}
		}

		allowHeaders := strings.TrimSpace(r.Header.Get("Access-Control-Request-Headers"))
		if allowHeaders == "" {
			allowHeaders = "Content-Type, Authorization, X-API-Key, X-Requested-With"
		}
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD")
		w.Header().Set("Access-Control-Allow-Headers", allowHeaders)
		w.Header().Set("Access-Control-Expose-Headers", "Content-Type, Content-Length, Authorization")
		w.Header().Set("Access-Control-Max-Age", "86400")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}
		mux.ServeHTTP(w, r)
	})

	httpServer := &http.Server{
		Addr:              ":" + cfg.HTTPPort,
		Handler:           corsHandler,
		ReadHeaderTimeout: time.Duration(cfg.HTTPReadTimeoutSec) * time.Second,
		ReadTimeout:       time.Duration(cfg.HTTPReadTimeoutSec) * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       time.Duration(cfg.HTTPIdleTimeoutSec) * time.Second,
		MaxHeaderBytes:    1 << 20,
	}

	go func() {
		log.Printf("[API] Central Control Plane API listening on :%s", cfg.HTTPPort)
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("[FATAL] Server error: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop

	log.Println("\n[SHUTDOWN] Shutting down Central Control Plane Backend gracefully...")
	cancel()

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer shutdownCancel()
	_ = httpServer.Shutdown(shutdownCtx)

	fmt.Println("Central Control Plane Backend stopped.")
}
