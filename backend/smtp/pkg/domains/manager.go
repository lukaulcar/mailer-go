package domains

import (
	"crypto/rsa"
	"database/sql"
	"fmt"
	"log"
	"strings"
	"sync"

	"mailer-go/backend/shared/crypto"
	"mailer-go/backend/shared/models"
	_ "modernc.org/sqlite"
)

type LocalDomain struct {
	Domain        string
	Selector      string
	PrivateKey    *rsa.PrivateKey
	PrivateKeyPEM string
	PublicKeyB64  string
	IsActive      bool
	UpdatedAt     int64
}

type LocalAlias struct {
	ID          string
	Domain      string
	Address     string
	Destination string
	IsActive    bool
	UpdatedAt   int64
}

type DomainManager struct {
	mu      sync.RWMutex
	domains map[string]*LocalDomain
	aliases map[string][]*LocalAlias
	db      *sql.DB
}

func NewDomainManager(db *sql.DB) (*DomainManager, error) {
	dm := &DomainManager{
		domains: make(map[string]*LocalDomain),
		aliases: make(map[string][]*LocalAlias),
		db:      db,
	}

	if err := dm.initSchema(); err != nil {
		return nil, fmt.Errorf("failed to init local domains schema: %w", err)
	}

	if err := dm.LoadFromLocalDB(); err != nil {
		return nil, fmt.Errorf("failed to load local domains from sqlite: %w", err)
	}

	return dm, nil
}

func (dm *DomainManager) initSchema() error {
	schema := `
	CREATE TABLE IF NOT EXISTS local_domains (
		domain TEXT PRIMARY KEY COLLATE NOCASE,
		selector TEXT NOT NULL DEFAULT 'mail',
		private_key_pem TEXT NOT NULL DEFAULT '',
		public_key_b64 TEXT NOT NULL DEFAULT '',
		is_active INTEGER NOT NULL DEFAULT 1,
		updated_at INTEGER NOT NULL
	);

	CREATE TABLE IF NOT EXISTS local_aliases (
		id TEXT PRIMARY KEY,
		domain TEXT NOT NULL COLLATE NOCASE,
		address TEXT NOT NULL COLLATE NOCASE,
		destination TEXT NOT NULL,
		is_active INTEGER NOT NULL DEFAULT 1,
		updated_at INTEGER NOT NULL,
		UNIQUE(domain, address)
	);

	CREATE INDEX IF NOT EXISTS idx_local_aliases_domain ON local_aliases(domain);
	`
	_, err := dm.db.Exec(schema)
	return err
}

func (dm *DomainManager) LoadFromLocalDB() error {
	dm.mu.Lock()
	defer dm.mu.Unlock()

	dm.domains = make(map[string]*LocalDomain)
	dm.aliases = make(map[string][]*LocalAlias)

	dRows, err := dm.db.Query(`SELECT domain, selector, private_key_pem, public_key_b64, is_active, updated_at FROM local_domains WHERE is_active = 1`)
	if err != nil {
		return fmt.Errorf("failed to query local_domains: %w", err)
	}
	defer dRows.Close()

	for dRows.Next() {
		var (
			d, selector, privPEM, pubB64 string
			isActive                     int
			updatedAt                    int64
		)
		if err := dRows.Scan(&d, &selector, &privPEM, &pubB64, &isActive, &updatedAt); err == nil {
			cleanDomain := strings.ToLower(strings.TrimSpace(d))
			var rsaKey *rsa.PrivateKey
			if privPEM != "" {
				rsaKey, _ = crypto.ParsePrivateKeyPEM(privPEM)
			}

			dm.domains[cleanDomain] = &LocalDomain{
				Domain:        cleanDomain,
				Selector:      selector,
				PrivateKey:    rsaKey,
				PrivateKeyPEM: privPEM,
				PublicKeyB64:  pubB64,
				IsActive:      isActive == 1,
				UpdatedAt:     updatedAt,
			}
		}
	}
	if err := dRows.Err(); err != nil {
		return fmt.Errorf("error iterating local_domains: %w", err)
	}

	aRows, err := dm.db.Query(`SELECT id, domain, address, destination, is_active, updated_at FROM local_aliases WHERE is_active = 1`)
	if err != nil {
		return fmt.Errorf("failed to query local_aliases: %w", err)
	}
	defer aRows.Close()

	for aRows.Next() {
		var (
			id, domain, addr, dest string
			isActive               int
			updatedAt              int64
		)
		if err := aRows.Scan(&id, &domain, &addr, &dest, &isActive, &updatedAt); err == nil {
			cleanDomain := strings.ToLower(strings.TrimSpace(domain))
			cleanAddr := strings.ToLower(strings.TrimSpace(addr))
			alias := &LocalAlias{
				ID:          id,
				Domain:      cleanDomain,
				Address:     cleanAddr,
				Destination: dest,
				IsActive:    isActive == 1,
				UpdatedAt:   updatedAt,
			}
			dm.aliases[cleanDomain] = append(dm.aliases[cleanDomain], alias)
		}
	}
	if err := aRows.Err(); err != nil {
		return fmt.Errorf("error iterating local_aliases: %w", err)
	}

	log.Printf("[LOCAL STORAGE] Loaded %d domain(s) and %d alias(es) from local SQLite.", len(dm.domains), dm.countAliases())
	return nil
}

func (dm *DomainManager) countAliases() int {
	total := 0
	for _, list := range dm.aliases {
		total += len(list)
	}
	return total
}

func (dm *DomainManager) UpdateFromSync(syncDomains []models.SyncDomain, syncAliases []models.SyncAlias) error {
	tx, err := dm.db.Begin()
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.Exec(`DELETE FROM local_domains`); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM local_aliases`); err != nil {
		return err
	}

	dStmt, err := tx.Prepare(`INSERT INTO local_domains (domain, selector, private_key_pem, public_key_b64, is_active, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return err
	}
	defer dStmt.Close()

	newDomains := make(map[string]*LocalDomain)
	for _, sd := range syncDomains {
		if !sd.IsActive {
			continue
		}
		cleanDomain := strings.ToLower(strings.TrimSpace(sd.Domain))
		if _, err := dStmt.Exec(cleanDomain, sd.Selector, sd.PrivateKeyPEM, sd.PublicKeyB64, 1, sd.UpdatedAt); err != nil {
			return err
		}

		var rsaKey *rsa.PrivateKey
		if sd.PrivateKeyPEM != "" {
			rsaKey, _ = crypto.ParsePrivateKeyPEM(sd.PrivateKeyPEM)
		}

		newDomains[cleanDomain] = &LocalDomain{
			Domain:        cleanDomain,
			Selector:      sd.Selector,
			PrivateKey:    rsaKey,
			PrivateKeyPEM: sd.PrivateKeyPEM,
			PublicKeyB64:  sd.PublicKeyB64,
			IsActive:      true,
			UpdatedAt:     sd.UpdatedAt,
		}
	}

	aStmt, err := tx.Prepare(`INSERT INTO local_aliases (id, domain, address, destination, is_active, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return err
	}
	defer aStmt.Close()

	newAliases := make(map[string][]*LocalAlias)
	for _, sa := range syncAliases {
		if !sa.IsActive {
			continue
		}
		cleanDomain := strings.ToLower(strings.TrimSpace(sa.Domain))
		cleanAddr := strings.ToLower(strings.TrimSpace(sa.Address))
		if _, err := aStmt.Exec(sa.ID, cleanDomain, cleanAddr, sa.Destination, 1, sa.UpdatedAt); err != nil {
			return err
		}

		alias := &LocalAlias{
			ID:          sa.ID,
			Domain:      cleanDomain,
			Address:     cleanAddr,
			Destination: sa.Destination,
			IsActive:    true,
			UpdatedAt:   sa.UpdatedAt,
		}
		newAliases[cleanDomain] = append(newAliases[cleanDomain], alias)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("failed to commit sync transaction: %w", err)
	}

	dm.mu.Lock()
	dm.domains = newDomains
	dm.aliases = newAliases
	dm.mu.Unlock()

	log.Printf("[SYNC APPLIED] Updated local SQLite and memory: %d active domain(s), %d alias(es).", len(newDomains), len(syncAliases))
	return nil
}

func (dm *DomainManager) UpsertDomain(sd models.SyncDomain) error {
	cleanDomain := strings.ToLower(strings.TrimSpace(sd.Domain))
	if cleanDomain == "" {
		return fmt.Errorf("empty domain name")
	}
	if !crypto.ValidateDomain(cleanDomain) {
		return fmt.Errorf("invalid domain name %q", cleanDomain)
	}

	if !sd.IsActive {
		return dm.DeleteDomain(cleanDomain)
	}

	query := `
	INSERT INTO local_domains (domain, selector, private_key_pem, public_key_b64, is_active, updated_at)
	VALUES (?, ?, ?, ?, 1, ?)
	ON CONFLICT(domain) DO UPDATE SET
		selector = excluded.selector,
		private_key_pem = excluded.private_key_pem,
		public_key_b64 = excluded.public_key_b64,
		is_active = 1,
		updated_at = excluded.updated_at
	`
	_, err := dm.db.Exec(query, cleanDomain, sd.Selector, sd.PrivateKeyPEM, sd.PublicKeyB64, sd.UpdatedAt)
	if err != nil {
		return fmt.Errorf("failed to upsert local_domains: %w", err)
	}

	var rsaKey *rsa.PrivateKey
	if sd.PrivateKeyPEM != "" {
		rsaKey, _ = crypto.ParsePrivateKeyPEM(sd.PrivateKeyPEM)
	}

	dm.mu.Lock()
	dm.domains[cleanDomain] = &LocalDomain{
		Domain:        cleanDomain,
		Selector:      sd.Selector,
		PrivateKey:    rsaKey,
		PrivateKeyPEM: sd.PrivateKeyPEM,
		PublicKeyB64:  sd.PublicKeyB64,
		IsActive:      true,
		UpdatedAt:     sd.UpdatedAt,
	}
	dm.mu.Unlock()

	log.Printf("[REAL-TIME PUSH] Upserted domain %q with selector %q in local SQLite and memory cache.", cleanDomain, sd.Selector)
	return nil
}

func (dm *DomainManager) DeleteDomain(domain string) error {
	cleanDomain := strings.ToLower(strings.TrimSpace(domain))
	if cleanDomain == "" {
		return nil
	}

	_, err := dm.db.Exec(`DELETE FROM local_domains WHERE domain = ? COLLATE NOCASE`, cleanDomain)
	if err != nil {
		return fmt.Errorf("failed to delete from local_domains: %w", err)
	}
	_, _ = dm.db.Exec(`DELETE FROM local_aliases WHERE domain = ? COLLATE NOCASE`, cleanDomain)

	dm.mu.Lock()
	delete(dm.domains, cleanDomain)
	delete(dm.aliases, cleanDomain)
	dm.mu.Unlock()

	log.Printf("[REAL-TIME PUSH] Deleted domain %q from local SQLite and memory cache.", cleanDomain)
	return nil
}

func (dm *DomainManager) IsRecipientAllowed(recipient string) (bool, string) {
	domain := crypto.ExtractDomain(recipient)
	if domain == "" {
		return false, ""
	}

	dm.mu.RLock()
	defer dm.mu.RUnlock()

	entry := dm.domains[domain]
	if entry == nil || !entry.IsActive {
		return false, domain
	}

	return true, domain
}

func (dm *DomainManager) ListDomains() []string {
	dm.mu.RLock()
	defer dm.mu.RUnlock()

	list := make([]string, 0, len(dm.domains))
	for d, entry := range dm.domains {
		if entry.IsActive {
			list = append(list, d)
		}
	}
	return list
}

func (dm *DomainManager) GetSigningKey(domain string) (*rsa.PrivateKey, string, bool) {
	clean := strings.ToLower(strings.TrimSpace(domain))
	dm.mu.RLock()
	defer dm.mu.RUnlock()

	entry, ok := dm.domains[clean]
	if !ok || entry == nil || !entry.IsActive || entry.PrivateKey == nil {
		return nil, "", false
	}
	return entry.PrivateKey, entry.Selector, true
}

func ExtractDomain(addr string) string {
	return crypto.ExtractDomain(addr)
}
