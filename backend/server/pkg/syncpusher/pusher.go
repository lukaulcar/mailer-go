package syncpusher

import (
	"context"
	"log"
	"sync"
	"time"

	"mailer-go/backend/server/pkg/db"
	"mailer-go/backend/server/pkg/relayclient"
)

type SyncPusher struct {
	db          *db.DB
	relayClient *relayclient.RelayClient
	mu          sync.Mutex
	httpMu      sync.Mutex
	running     bool
	pending     bool
}

func NewSyncPusher(database *db.DB, relayClient *relayclient.RelayClient) *SyncPusher {
	return &SyncPusher{
		db:          database,
		relayClient: relayClient,
	}
}

func (p *SyncPusher) pushInternal() error {
	p.httpMu.Lock()
	defer p.httpMu.Unlock()

	domains, aliases, err := p.db.GetSyncState("*")
	if err != nil {
		log.Printf("[SYNC PUSH ERROR] Failed to load sync state from DB: %v", err)
		return err
	}

	if err := p.relayClient.PushSyncState(domains, aliases); err != nil {
		log.Printf("[SYNC PUSH WARNING] Failed to push domain sync to SMTP service: %v", err)
		return err
	}

	log.Printf("[SYNC PUSH SUCCESS] Pushed %d active domain(s) and %d alias(es) to SMTP service.", len(domains), len(aliases))
	return nil
}

func (p *SyncPusher) PushNow() error {
	p.mu.Lock()
	p.pending = false
	p.mu.Unlock()
	return p.pushInternal()
}

func (p *SyncPusher) TriggerPush() {
	p.mu.Lock()
	if p.running {
		p.pending = true
		p.mu.Unlock()
		return
	}
	p.running = true
	p.mu.Unlock()

	go func() {
		for {
			_ = p.pushInternal()

			p.mu.Lock()
			if !p.pending {
				p.running = false
				p.mu.Unlock()
				return
			}
			p.pending = false
			p.mu.Unlock()
		}
	}()
}

func (p *SyncPusher) StartPeriodicPush(ctx context.Context, interval time.Duration) {
	if interval < 10*time.Second {
		interval = 60 * time.Second
	}
	go func() {
		log.Printf("[SYNC PUSHER] Started periodic domain sync worker (interval: %v).", interval)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()

		for {
			select {
			case <-ctx.Done():
				log.Println("[SYNC PUSHER] Periodic worker stopped.")
				return
			case <-ticker.C:
				_ = p.PushNow()
			}
		}
	}()
}
