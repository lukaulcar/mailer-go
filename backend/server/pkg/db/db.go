package db

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"strings"
	"time"

	"mailer-go/backend/shared/crypto"
	"mailer-go/backend/shared/emailparser"
	"mailer-go/backend/shared/models"

	_ "modernc.org/sqlite"
)

type DB struct {
	db *sql.DB
}

func New(dbPath string) (*DB, error) {
	if dbPath == "" {
		dbPath = "central_backend.db"
	}

	dsn := fmt.Sprintf("%s?_pragma=busy_timeout(10000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)", dbPath)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("failed to open sqlite db: %w", err)
	}
	db.SetMaxOpenConns(10)
	db.SetMaxIdleConns(5)

	d := &DB{db: db}
	if err := d.migrate(); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("failed to migrate db: %w", err)
	}

	return d, nil
}

func (d *DB) Close() error {
	return d.db.Close()
}

func (d *DB) migrate() error {
	schema := `
	CREATE TABLE IF NOT EXISTS domains (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL UNIQUE COLLATE NOCASE,
		selector TEXT NOT NULL DEFAULT 'mail',
		dkim_private_key_pem TEXT NOT NULL,
		dkim_public_key_b64 TEXT NOT NULL,
		is_active INTEGER NOT NULL DEFAULT 1,
		is_verified INTEGER NOT NULL DEFAULT 0,
		spf_status TEXT NOT NULL DEFAULT 'pending',
		dkim_status TEXT NOT NULL DEFAULT 'pending',
		dmarc_status TEXT NOT NULL DEFAULT 'pending',
		mx_status TEXT NOT NULL DEFAULT 'pending',
		last_dns_check_at INTEGER NOT NULL DEFAULT 0,
		assigned_mx_server_id TEXT NOT NULL DEFAULT '*',
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	);

	CREATE INDEX IF NOT EXISTS idx_domains_active ON domains(is_active);
	CREATE INDEX IF NOT EXISTS idx_domains_assigned_mx ON domains(assigned_mx_server_id);

	CREATE TABLE IF NOT EXISTS aliases (
		id TEXT PRIMARY KEY,
		domain_id TEXT NOT NULL,
		domain TEXT NOT NULL COLLATE NOCASE,
		address TEXT NOT NULL COLLATE NOCASE,
		destination TEXT NOT NULL,
		is_active INTEGER NOT NULL DEFAULT 1,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL,
		UNIQUE(domain, address),
		FOREIGN KEY(domain_id) REFERENCES domains(id) ON DELETE CASCADE
	);

	CREATE INDEX IF NOT EXISTS idx_aliases_domain ON aliases(domain);

	CREATE TABLE IF NOT EXISTS mx_servers (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		api_key TEXT NOT NULL UNIQUE,
		hostname TEXT NOT NULL,
		last_seen_at INTEGER NOT NULL DEFAULT 0,
		created_at INTEGER NOT NULL
	);

	CREATE TABLE IF NOT EXISTS api_keys (
		id TEXT PRIMARY KEY,
		label TEXT NOT NULL,
		prefix TEXT NOT NULL UNIQUE,
		secret_hash TEXT NOT NULL UNIQUE,
		scope_type TEXT NOT NULL DEFAULT 'domain',
		domains_json TEXT NOT NULL DEFAULT '[]',
		mailbox TEXT NOT NULL DEFAULT '',
		mailboxes_json TEXT NOT NULL DEFAULT '[]',
		permissions_json TEXT NOT NULL DEFAULT '["send"]',
		expires_at INTEGER NOT NULL DEFAULT 0,
		created_at INTEGER NOT NULL,
		revoked INTEGER NOT NULL DEFAULT 0
	);
	CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(prefix);

	CREATE TABLE IF NOT EXISTS mail_templates (
		id TEXT PRIMARY KEY,
		domain TEXT NOT NULL COLLATE NOCASE,
		mailbox TEXT NOT NULL COLLATE NOCASE,
		name TEXT NOT NULL COLLATE NOCASE,
		subject TEXT NOT NULL DEFAULT '',
		html TEXT NOT NULL DEFAULT '',
		text TEXT NOT NULL DEFAULT '',
		updated_at INTEGER NOT NULL,
		UNIQUE(mailbox, name)
	);
	CREATE INDEX IF NOT EXISTS idx_templates_mailbox ON mail_templates(mailbox);
	CREATE INDEX IF NOT EXISTS idx_templates_domain ON mail_templates(domain);

	CREATE TABLE IF NOT EXISTS mailboxes (
		id TEXT PRIMARY KEY,
		address TEXT NOT NULL UNIQUE COLLATE NOCASE,
		display_name TEXT NOT NULL DEFAULT '',
		domain TEXT NOT NULL COLLATE NOCASE,
		password_hash TEXT NOT NULL,
		kind TEXT NOT NULL DEFAULT 'standard',
		enabled INTEGER NOT NULL DEFAULT 1,
		used_bytes INTEGER NOT NULL DEFAULT 0,
		quota_bytes INTEGER NOT NULL DEFAULT 0,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_mailboxes_domain ON mailboxes(domain);

	CREATE TABLE IF NOT EXISTS messages (
		id TEXT PRIMARY KEY,
		mailbox TEXT NOT NULL COLLATE NOCASE,
		folder TEXT NOT NULL DEFAULT 'inbox',
		from_address TEXT NOT NULL,
		to_address TEXT NOT NULL,
		subject TEXT NOT NULL,
		body TEXT NOT NULL,
		body_html TEXT NOT NULL DEFAULT '',
		raw_path TEXT NOT NULL DEFAULT '',
		size_bytes INTEGER NOT NULL DEFAULT 0,
		is_read INTEGER NOT NULL DEFAULT 0,
		is_starred INTEGER NOT NULL DEFAULT 0,
		created_at INTEGER NOT NULL,
		FOREIGN KEY(mailbox) REFERENCES mailboxes(address) ON DELETE CASCADE
	);
	CREATE INDEX IF NOT EXISTS idx_messages_mailbox_folder ON messages(mailbox, folder);
	CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at DESC);

	CREATE TABLE IF NOT EXISTS attachments (
		id TEXT PRIMARY KEY,
		message_id TEXT NOT NULL,
		mailbox TEXT NOT NULL COLLATE NOCASE,
		filename TEXT NOT NULL,
		content_type TEXT NOT NULL,
		size_bytes INTEGER NOT NULL,
		storage_path TEXT NOT NULL,
		sha256 TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		content_id TEXT NOT NULL DEFAULT '',
		is_inline INTEGER NOT NULL DEFAULT 0,
		FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE
	);
	CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);

	CREATE TABLE IF NOT EXISTS subscriptions (
		id TEXT PRIMARY KEY,
		domain TEXT NOT NULL COLLATE NOCASE,
		url TEXT NOT NULL,
		events_json TEXT NOT NULL DEFAULT '[]',
		secret TEXT NOT NULL,
		enabled INTEGER NOT NULL DEFAULT 1,
		created_at INTEGER NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_subscriptions_domain ON subscriptions(domain);
	`
	if _, err := d.db.Exec(schema); err != nil {
		return err
	}
	return nil
}

func (d *DB) UpsertDomain(dom *models.Domain) error {
	now := time.Now().Unix()
	if dom.ID == "" {
		dom.ID = crypto.GenerateID("dom")
	}
	cleanName := strings.ToLower(strings.TrimSpace(dom.Name))
	selector := strings.TrimSpace(dom.Selector)
	if selector == "" {
		selector = "mail"
	}
	assignedMX := dom.AssignedMXServerID
	if assignedMX == "" {
		assignedMX = "*"
	}

	isActiveInt := 0
	if dom.IsActive {
		isActiveInt = 1
	}
	isVerifiedInt := 0
	if dom.IsVerified {
		isVerifiedInt = 1
	}

	spfStatus := dom.SPFStatus
	if spfStatus == "" {
		spfStatus = "pending"
	}
	dkimStatus := dom.DKIMStatus
	if dkimStatus == "" {
		dkimStatus = "pending"
	}
	dmarcStatus := dom.DMARCStatus
	if dmarcStatus == "" {
		dmarcStatus = "pending"
	}
	mxStatus := dom.MXStatus
	if mxStatus == "" {
		mxStatus = "pending"
	}

	query := `
	INSERT INTO domains (
		id, name, selector, dkim_private_key_pem, dkim_public_key_b64,
		is_active, is_verified, spf_status, dkim_status, dmarc_status, mx_status,
		last_dns_check_at, assigned_mx_server_id, created_at, updated_at
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT(name) DO UPDATE SET
		selector = excluded.selector,
		dkim_private_key_pem = excluded.dkim_private_key_pem,
		dkim_public_key_b64 = excluded.dkim_public_key_b64,
		assigned_mx_server_id = excluded.assigned_mx_server_id,
		is_active = excluded.is_active,
		is_verified = excluded.is_verified,
		spf_status = excluded.spf_status,
		dkim_status = excluded.dkim_status,
		dmarc_status = excluded.dmarc_status,
		mx_status = excluded.mx_status,
		last_dns_check_at = excluded.last_dns_check_at,
		updated_at = excluded.updated_at
	`
	_, err := d.db.Exec(query,
		dom.ID, cleanName, selector, dom.DKIMPrivateKeyPEM, dom.DKIMPublicKeyB64,
		isActiveInt, isVerifiedInt, spfStatus, dkimStatus, dmarcStatus, mxStatus,
		dom.LastDNSCheckAt, assignedMX, now, now,
	)
	return err
}

func (d *DB) GetDomain(name string) (*models.Domain, error) {
	cleanName := strings.ToLower(strings.TrimSpace(name))
	query := `
	SELECT id, name, selector, dkim_private_key_pem, dkim_public_key_b64,
	       is_active, is_verified, spf_status, dkim_status, dmarc_status, mx_status,
	       last_dns_check_at, assigned_mx_server_id, created_at, updated_at
	FROM domains
	WHERE name = ? COLLATE NOCASE
	`
	row := d.db.QueryRow(query, cleanName)

	var dom models.Domain
	var isActive, isVerified int
	err := row.Scan(
		&dom.ID, &dom.Name, &dom.Selector, &dom.DKIMPrivateKeyPEM, &dom.DKIMPublicKeyB64,
		&isActive, &isVerified, &dom.SPFStatus, &dom.DKIMStatus, &dom.DMARCStatus, &dom.MXStatus,
		&dom.LastDNSCheckAt, &dom.AssignedMXServerID, &dom.CreatedAt, &dom.UpdatedAt,
	)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, fmt.Errorf("domain %q not found", cleanName)
		}
		return nil, err
	}

	dom.IsActive = isActive == 1
	dom.IsVerified = isVerified == 1
	return &dom, nil
}

func (d *DB) ListDomains() ([]*models.Domain, error) {
	query := `
	SELECT id, name, selector, dkim_private_key_pem, dkim_public_key_b64,
	       is_active, is_verified, spf_status, dkim_status, dmarc_status, mx_status,
	       last_dns_check_at, assigned_mx_server_id, created_at, updated_at
	FROM domains
	ORDER BY created_at DESC
	`
	rows, err := d.db.Query(query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var domains []*models.Domain
	for rows.Next() {
		var dom models.Domain
		var isActive, isVerified int
		if err := rows.Scan(
			&dom.ID, &dom.Name, &dom.Selector, &dom.DKIMPrivateKeyPEM, &dom.DKIMPublicKeyB64,
			&isActive, &isVerified, &dom.SPFStatus, &dom.DKIMStatus, &dom.DMARCStatus, &dom.MXStatus,
			&dom.LastDNSCheckAt, &dom.AssignedMXServerID, &dom.CreatedAt, &dom.UpdatedAt,
		); err != nil {
			return nil, err
		}
		dom.IsActive = isActive == 1
		dom.IsVerified = isVerified == 1
		domains = append(domains, &dom)
	}

	return domains, nil
}

func (d *DB) DeleteDomain(name string) (*models.Domain, error) {
	dom, err := d.GetDomain(name)
	if err != nil {
		return nil, err
	}

	_, err = d.db.Exec(`DELETE FROM domains WHERE name = ? COLLATE NOCASE`, dom.Name)
	if err != nil {
		return nil, fmt.Errorf("failed to delete domain %q: %w", dom.Name, err)
	}

	return dom, nil
}

func (d *DB) UpdateDomainDNSStatus(domainName string, isVerified bool, spf, dkim, dmarc, mx string, lastCheck int64) error {
	cleanName := strings.ToLower(strings.TrimSpace(domainName))
	verInt := 0
	if isVerified {
		verInt = 1
	}

	now := time.Now().Unix()
	query := `
	UPDATE domains SET
		is_verified = ?,
		spf_status = ?,
		dkim_status = ?,
		dmarc_status = ?,
		mx_status = ?,
		last_dns_check_at = ?,
		updated_at = ?
	WHERE name = ? COLLATE NOCASE
	`
	_, err := d.db.Exec(query, verInt, spf, dkim, dmarc, mx, lastCheck, now, cleanName)
	return err
}

func (d *DB) SetDomainActive(domainName string, active bool) error {
	cleanName := strings.ToLower(strings.TrimSpace(domainName))
	actInt := 0
	if active {
		actInt = 1
	}
	now := time.Now().Unix()
	_, err := d.db.Exec(`UPDATE domains SET is_active = ?, updated_at = ? WHERE name = ? COLLATE NOCASE`, actInt, now, cleanName)
	return err
}

func (d *DB) CreateAlias(domainName, address, destination string) (*models.Alias, error) {
	dom, err := d.GetDomain(domainName)
	if err != nil {
		return nil, err
	}

	cleanAddr := strings.ToLower(strings.TrimSpace(address))
	if cleanAddr == "" {
		return nil, fmt.Errorf("alias address is required")
	}

	if !strings.Contains(cleanAddr, "@") {
		cleanAddr = fmt.Sprintf("%s@%s", cleanAddr, dom.Name)
	}

	now := time.Now().Unix()
	aliasID := crypto.GenerateID("als")

	query := `
	INSERT INTO aliases (id, domain_id, domain, address, destination, is_active, created_at, updated_at)
	VALUES (?, ?, ?, ?, ?, 1, ?, ?)
	ON CONFLICT(domain, address) DO UPDATE SET
		destination = excluded.destination,
		is_active = 1,
		updated_at = excluded.updated_at
	`

	_, err = d.db.Exec(query, aliasID, dom.ID, dom.Name, cleanAddr, destination, now, now)
	if err != nil {
		return nil, fmt.Errorf("failed to save alias: %w", err)
	}

	return &models.Alias{
		ID:          aliasID,
		DomainID:    dom.ID,
		Domain:      dom.Name,
		Address:     cleanAddr,
		Destination: destination,
		IsActive:    true,
		CreatedAt:   now,
		UpdatedAt:   now,
	}, nil
}

func (d *DB) ListAliasesByDomain(domainName string) ([]*models.Alias, error) {
	cleanName := strings.ToLower(strings.TrimSpace(domainName))
	query := `
	SELECT id, domain_id, domain, address, destination, is_active, created_at, updated_at
	FROM aliases
	WHERE domain = ? COLLATE NOCASE AND is_active = 1
	ORDER BY address ASC
	`
	rows, err := d.db.Query(query, cleanName)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var aliases []*models.Alias
	for rows.Next() {
		var a models.Alias
		var isActive int
		if err := rows.Scan(&a.ID, &a.DomainID, &a.Domain, &a.Address, &a.Destination, &isActive, &a.CreatedAt, &a.UpdatedAt); err != nil {
			return nil, err
		}
		a.IsActive = isActive == 1
		aliases = append(aliases, &a)
	}
	return aliases, nil
}

func (d *DB) DeleteAlias(aliasID string) (*models.Alias, error) {
	a, err := d.GetAliasByID(aliasID)
	if err != nil {
		return nil, err
	}

	_, err = d.db.Exec(`DELETE FROM aliases WHERE id = ?`, aliasID)
	if err != nil {
		return nil, err
	}
	return a, nil
}

func (d *DB) GetAliasByID(aliasID string) (*models.Alias, error) {
	query := `SELECT id, domain_id, domain, address, destination, is_active, created_at, updated_at FROM aliases WHERE id = ?`
	row := d.db.QueryRow(query, aliasID)

	var a models.Alias
	var isActive int
	if err := row.Scan(&a.ID, &a.DomainID, &a.Domain, &a.Address, &a.Destination, &isActive, &a.CreatedAt, &a.UpdatedAt); err != nil {
		return nil, fmt.Errorf("alias %q not found", aliasID)
	}
	a.IsActive = isActive == 1
	return &a, nil
}

func (d *DB) GetSyncState(assignedMXID string) ([]models.SyncDomain, []models.SyncAlias, error) {
	query := `
	SELECT name, selector, dkim_private_key_pem, dkim_public_key_b64, is_active, updated_at
	FROM domains
	WHERE is_active = 1 AND (assigned_mx_server_id = '*' OR assigned_mx_server_id = ? OR ? = '')
	`
	rows, err := d.db.Query(query, assignedMXID, assignedMXID)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to query sync domains: %w", err)
	}
	defer rows.Close()

	var domains []models.SyncDomain
	domainMap := make(map[string]bool)
	for rows.Next() {
		var sd models.SyncDomain
		var isActive int
		if err := rows.Scan(&sd.Domain, &sd.Selector, &sd.PrivateKeyPEM, &sd.PublicKeyB64, &isActive, &sd.UpdatedAt); err != nil {
			return nil, nil, err
		}
		sd.IsActive = isActive == 1
		domains = append(domains, sd)
		domainMap[strings.ToLower(sd.Domain)] = true
	}

	aliasQuery := `
	SELECT id, domain, address, destination, is_active, updated_at
	FROM aliases
	WHERE is_active = 1
	`
	aRows, err := d.db.Query(aliasQuery)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to query sync aliases: %w", err)
	}
	defer aRows.Close()

	var aliases []models.SyncAlias
	for aRows.Next() {
		var sa models.SyncAlias
		var isActive int
		if err := aRows.Scan(&sa.ID, &sa.Domain, &sa.Address, &sa.Destination, &isActive, &sa.UpdatedAt); err != nil {
			return nil, nil, err
		}
		sa.IsActive = isActive == 1
		if domainMap[strings.ToLower(sa.Domain)] {
			aliases = append(aliases, sa)
		}
	}

	return domains, aliases, nil
}

func randomSecret() (raw, prefix, hash string) {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	raw = "mg_live_" + hex.EncodeToString(b)
	sum := sha256.Sum256([]byte(raw))
	hash = hex.EncodeToString(sum[:])
	prefix = "mg_live_…" + hex.EncodeToString(b[:2])
	return raw, prefix, hash
}

func normalizeDomains(in []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, d := range in {
		clean := strings.ToLower(strings.TrimSpace(d))
		if clean == "" || seen[clean] {
			continue
		}
		seen[clean] = true
		out = append(out, clean)
	}
	return out
}

func normalizeMailboxes(in []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, m := range in {
		clean := strings.ToLower(strings.TrimSpace(m))
		if clean == "" || !strings.Contains(clean, "@") || seen[clean] {
			continue
		}
		seen[clean] = true
		out = append(out, clean)
	}
	return out
}

func (d *DB) CreateApiKey(label string, scopeType models.ApiKeyScopeType, domains []string, mailbox string, mailboxes []string, permissions []string, expiresAt *int64) (*models.ApiKey, string, error) {
	cleanLabel := strings.TrimSpace(label)
	if cleanLabel == "" {
		cleanLabel = "API key"
	}
	domains = normalizeDomains(domains)
	mailbox = strings.ToLower(strings.TrimSpace(mailbox))
	mailboxes = normalizeMailboxes(mailboxes)
	if mailbox != "" {
		merged := append([]string{mailbox}, mailboxes...)
		mailboxes = normalizeMailboxes(merged)
		mailbox = mailboxes[0]
	}
	if scopeType != models.KeyScopeDomain && scopeType != models.KeyScopeDomains && scopeType != models.KeyScopeMailbox && scopeType != models.KeyScopeMailboxes {
		scopeType = models.KeyScopeDomain
	}
	if scopeType == models.KeyScopeMailbox {
		if len(mailboxes) == 0 {
			return nil, "", fmt.Errorf("mailbox scope requires at least one address, e.g. no-reply@example.com")
		}
		parts := strings.SplitN(mailboxes[0], "@", 2)
		if len(parts) == 2 {
			domains = []string{parts[1]}
		}
		domains = normalizeDomains(append(domains, parentDomains(mailboxes)...))
	}
	if scopeType == models.KeyScopeMailboxes {
		if len(mailboxes) == 0 {
			return nil, "", fmt.Errorf("pick at least one mailbox for this key")
		}
		domains = normalizeDomains(append(domains, parentDomains(mailboxes)...))
	}
	if (scopeType == models.KeyScopeDomain || scopeType == models.KeyScopeDomains) && len(domains) == 0 {
		return nil, "", fmt.Errorf("pick at least one domain for this key")
	}
	if expiresAt != nil && *expiresAt <= time.Now().Unix() {
		return nil, "", fmt.Errorf("expiry must be in the future")
	}

	var cleanPerms []string
	seenPerm := make(map[string]bool)
	for _, p := range permissions {
		cp := strings.ToLower(strings.TrimSpace(p))
		if cp != "" && !seenPerm[cp] {
			seenPerm[cp] = true
			cleanPerms = append(cleanPerms, cp)
		}
	}
	if len(cleanPerms) == 0 {
		cleanPerms = []string{"send"}
	}
	permsJSON, _ := json.Marshal(cleanPerms)

	raw, prefix, hash := randomSecret()
	now := time.Now().Unix()
	id := crypto.GenerateID("key")
	domainsJSON, _ := json.Marshal(domains)
	mailboxesJSON, _ := json.Marshal(mailboxes)
	expVal := int64(0)
	var expPtr *int64
	if expiresAt != nil && *expiresAt > 0 {
		expVal = *expiresAt
		expPtr = &expVal
	}
	_, err := d.db.Exec(`INSERT INTO api_keys (id, label, prefix, secret_hash, scope_type, domains_json, mailbox, mailboxes_json, permissions_json, expires_at, created_at, revoked) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
		id, cleanLabel, prefix, hash, string(scopeType), string(domainsJSON), mailbox, string(mailboxesJSON), string(permsJSON), expVal, now)
	if err != nil {
		return nil, "", fmt.Errorf("failed to create api key: %w", err)
	}
	key := &models.ApiKey{
		ID: id, Label: cleanLabel, Prefix: prefix,
		ScopeType: scopeType, Domains: domains, Mailbox: mailbox, Mailboxes: mailboxes,
		Permissions: cleanPerms,
		Scope:       &models.ApiKeyScope{Type: scopeType, Domains: domains, Mailbox: mailbox, Mailboxes: mailboxes},
		CreatedAt:   now, ExpiresAt: expPtr,
	}
	return key, raw, nil
}

func parentDomains(mailboxes []string) []string {
	out := []string{}
	for _, mb := range mailboxes {
		parts := strings.SplitN(strings.ToLower(strings.TrimSpace(mb)), "@", 2)
		if len(parts) == 2 && parts[1] != "" {
			out = append(out, parts[1])
		}
	}
	return out
}

func buildApiKey(id, label, prefix, scopeType, domainsJSON, mailbox, mailboxesJSON, permissionsJSON string, expiresAt, createdAt int64, revoked int) *models.ApiKey {
	var domains []string
	_ = json.Unmarshal([]byte(domainsJSON), &domains)
	var mailboxes []string
	_ = json.Unmarshal([]byte(mailboxesJSON), &mailboxes)
	var permissions []string
	if permissionsJSON != "" {
		_ = json.Unmarshal([]byte(permissionsJSON), &permissions)
	}
	if len(permissions) == 0 {
		permissions = []string{"send"}
	}
	if mailbox != "" {
		found := false
		for _, mb := range mailboxes {
			if strings.EqualFold(mb, mailbox) {
				found = true
				break
			}
		}
		if !found {
			mailboxes = append([]string{mailbox}, mailboxes...)
		}
	}
	var expPtr *int64
	if expiresAt > 0 {
		v := expiresAt
		expPtr = &v
	}
	st := models.ApiKeyScopeType(scopeType)
	return &models.ApiKey{
		ID: id, Label: label, Prefix: prefix,
		ScopeType: st, Domains: domains, Mailbox: mailbox, Mailboxes: mailboxes,
		Permissions: permissions,
		Scope:       &models.ApiKeyScope{Type: st, Domains: domains, Mailbox: mailbox, Mailboxes: mailboxes},
		CreatedAt:   createdAt, ExpiresAt: expPtr, Revoked: revoked == 1,
	}
}

func (d *DB) ListApiKeys(filterDomain string) ([]*models.ApiKey, error) {
	rows, err := d.db.Query(`SELECT id, label, prefix, scope_type, domains_json, mailbox, mailboxes_json, COALESCE(permissions_json, '["send"]'), expires_at, created_at, revoked FROM api_keys WHERE revoked = 0 ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []*models.ApiKey
	for rows.Next() {
		var id, label, prefix, scopeType, domainsJSON, mailbox, mailboxesJSON, permissionsJSON string
		var createdAt, expiresAt int64
		var revoked int
		if err := rows.Scan(&id, &label, &prefix, &scopeType, &domainsJSON, &mailbox, &mailboxesJSON, &permissionsJSON, &expiresAt, &createdAt, &revoked); err != nil {
			return nil, err
		}
		k := buildApiKey(id, label, prefix, scopeType, domainsJSON, mailbox, mailboxesJSON, permissionsJSON, expiresAt, createdAt, revoked)
		if filterDomain != "" && !k.Covers(filterDomain, "") {
			continue
		}
		out = append(out, k)
	}
	return out, nil
}

func (d *DB) AuthenticateApiKey(raw string) (*models.ApiKey, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, fmt.Errorf("missing api key")
	}
	sum := sha256.Sum256([]byte(raw))
	hash := hex.EncodeToString(sum[:])
	row := d.db.QueryRow(`SELECT id, label, prefix, scope_type, domains_json, mailbox, mailboxes_json, COALESCE(permissions_json, '["send"]'), expires_at, created_at, revoked FROM api_keys WHERE secret_hash = ? AND revoked = 0`, hash)
	var id, label, prefix, scopeType, domainsJSON, mailbox, mailboxesJSON, permissionsJSON string
	var createdAt, expiresAt int64
	var revoked int
	if err := row.Scan(&id, &label, &prefix, &scopeType, &domainsJSON, &mailbox, &mailboxesJSON, &permissionsJSON, &expiresAt, &createdAt, &revoked); err != nil {
		if err == sql.ErrNoRows {
			return nil, fmt.Errorf("invalid api key")
		}
		return nil, err
	}
	k := buildApiKey(id, label, prefix, scopeType, domainsJSON, mailbox, mailboxesJSON, permissionsJSON, expiresAt, createdAt, revoked)
	if k.Expired(time.Now().Unix()) {
		return nil, fmt.Errorf("api key expired")
	}
	return k, nil
}

func (d *DB) GetApiKeyByID(id string) (*models.ApiKey, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return nil, fmt.Errorf("missing api key id")
	}
	row := d.db.QueryRow(`SELECT id, label, prefix, scope_type, domains_json, mailbox, mailboxes_json, COALESCE(permissions_json, '["send"]'), expires_at, created_at, revoked FROM api_keys WHERE id = ?`, id)
	var keyID, label, prefix, scopeType, domainsJSON, mailbox, mailboxesJSON, permissionsJSON string
	var createdAt, expiresAt int64
	var revoked int
	if err := row.Scan(&keyID, &label, &prefix, &scopeType, &domainsJSON, &mailbox, &mailboxesJSON, &permissionsJSON, &expiresAt, &createdAt, &revoked); err != nil {
		if err == sql.ErrNoRows {
			return nil, fmt.Errorf("api key %q not found", id)
		}
		return nil, err
	}
	return buildApiKey(keyID, label, prefix, scopeType, domainsJSON, mailbox, mailboxesJSON, permissionsJSON, expiresAt, createdAt, revoked), nil
}

func (d *DB) RevokeApiKey(id string) error {
	res, err := d.db.Exec(`UPDATE api_keys SET revoked = 1 WHERE id = ?`, id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("key %q not found", id)
	}
	return nil
}

func (d *DB) UpsertTemplate(domain, mailbox, name, subject, html, text string) (*models.MailTemplate, error) {
	domain = strings.ToLower(strings.TrimSpace(domain))
	mailbox = strings.ToLower(strings.TrimSpace(mailbox))
	name = strings.ToLower(strings.TrimSpace(name))
	if domain == "" && mailbox != "" {
		if parts := strings.Split(mailbox, "@"); len(parts) == 2 {
			domain = parts[1]
		}
	}
	if domain == "" {
		return nil, fmt.Errorf("domain is required")
	}

	if mailbox == "" || mailbox == "*" || mailbox == "@"+domain || mailbox == "*@"+domain {
		mailbox = "*@" + domain
	}
	if len(name) < 2 {
		return nil, fmt.Errorf("template name must be 2+ chars")
	}
	if strings.TrimSpace(subject) == "" {
		return nil, fmt.Errorf("subject is required")
	}
	if strings.TrimSpace(html) == "" {
		return nil, fmt.Errorf("html body is required")
	}
	now := time.Now().Unix()
	id := crypto.GenerateID("tpl")
	_, err := d.db.Exec(`INSERT INTO mail_templates (id, domain, mailbox, name, subject, html, text, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(mailbox, name) DO UPDATE SET subject = excluded.subject, html = excluded.html, text = excluded.text, updated_at = excluded.updated_at`,
		id, domain, mailbox, name, subject, html, text, now)
	if err != nil {
		return nil, fmt.Errorf("failed to save template: %w", err)
	}
	return d.GetTemplate(mailbox, name)
}

func (d *DB) GetTemplate(mailbox, name string) (*models.MailTemplate, error) {
	cleanMailbox := strings.ToLower(strings.TrimSpace(mailbox))
	cleanName := strings.ToLower(strings.TrimSpace(name))

	row := d.db.QueryRow(`SELECT id, domain, mailbox, name, subject, html, text, updated_at FROM mail_templates WHERE mailbox = ? COLLATE NOCASE AND name = ? COLLATE NOCASE`,
		cleanMailbox, cleanName)
	var t models.MailTemplate
	if err := row.Scan(&t.ID, &t.Domain, &t.Mailbox, &t.Name, &t.Subject, &t.HTML, &t.Text, &t.UpdatedAt); err == nil {
		return &t, nil
	}

	dom := cleanMailbox
	if parts := strings.Split(cleanMailbox, "@"); len(parts) == 2 {
		dom = parts[1]
	}
	if dom != "" {
		row2 := d.db.QueryRow(`SELECT id, domain, mailbox, name, subject, html, text, updated_at FROM mail_templates WHERE domain = ? COLLATE NOCASE AND name = ? COLLATE NOCASE AND (mailbox = ? OR mailbox = ? OR mailbox = '*' OR mailbox = '') ORDER BY updated_at DESC LIMIT 1`,
			dom, cleanName, "*@"+dom, "@"+dom)
		var t2 models.MailTemplate
		if err2 := row2.Scan(&t2.ID, &t2.Domain, &t2.Mailbox, &t2.Name, &t2.Subject, &t2.HTML, &t2.Text, &t2.UpdatedAt); err2 == nil {
			return &t2, nil
		}
	}

	return nil, fmt.Errorf("template %q not found for %q", name, mailbox)
}

func (d *DB) ListTemplatesByMailbox(mailbox string) ([]*models.MailTemplate, error) {
	rows, err := d.db.Query(`SELECT id, domain, mailbox, name, subject, html, text, updated_at FROM mail_templates WHERE mailbox = ? COLLATE NOCASE ORDER BY name ASC`, strings.TrimSpace(mailbox))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*models.MailTemplate
	for rows.Next() {
		var t models.MailTemplate
		if err := rows.Scan(&t.ID, &t.Domain, &t.Mailbox, &t.Name, &t.Subject, &t.HTML, &t.Text, &t.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, &t)
	}
	return out, nil
}

func (d *DB) ListTemplatesByDomain(domain string) ([]*models.MailTemplate, error) {
	rows, err := d.db.Query(`SELECT id, domain, mailbox, name, subject, html, text, updated_at FROM mail_templates WHERE domain = ? COLLATE NOCASE ORDER BY updated_at DESC, name ASC`, strings.TrimSpace(domain))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*models.MailTemplate
	for rows.Next() {
		var t models.MailTemplate
		if err := rows.Scan(&t.ID, &t.Domain, &t.Mailbox, &t.Name, &t.Subject, &t.HTML, &t.Text, &t.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, &t)
	}
	return out, nil
}

func (d *DB) GetTemplateByID(id string) (*models.MailTemplate, error) {
	row := d.db.QueryRow(`SELECT id, domain, mailbox, name, subject, html, text, updated_at FROM mail_templates WHERE id = ?`, id)
	var t models.MailTemplate
	if err := row.Scan(&t.ID, &t.Domain, &t.Mailbox, &t.Name, &t.Subject, &t.HTML, &t.Text, &t.UpdatedAt); err != nil {
		if err == sql.ErrNoRows {
			return nil, fmt.Errorf("template %q not found", id)
		}
		return nil, err
	}
	return &t, nil
}

func (d *DB) UpdateTemplate(id, name, subject, html, text, mailbox string) (*models.MailTemplate, error) {
	now := time.Now().Unix()
	existing, err := d.GetTemplateByID(id)
	if err != nil {
		return nil, err
	}
	cleanMailbox := existing.Mailbox
	if strings.TrimSpace(mailbox) != "" {
		m := strings.ToLower(strings.TrimSpace(mailbox))
		if m == "" || m == "*" || m == "@"+existing.Domain || m == "*@"+existing.Domain {
			cleanMailbox = "*@" + existing.Domain
		} else {
			cleanMailbox = m
		}
	}

	_, err = d.db.Exec(`UPDATE mail_templates SET name = ?, subject = ?, html = ?, text = ?, mailbox = ?, updated_at = ? WHERE id = ?`,
		strings.ToLower(strings.TrimSpace(name)), subject, html, text, cleanMailbox, now, id)
	if err != nil {
		return nil, err
	}
	return d.GetTemplateByID(id)
}

func (d *DB) DeleteTemplate(id string) error {
	_, err := d.db.Exec(`DELETE FROM mail_templates WHERE id = ?`, id)
	return err
}

func (d *DB) ListSubscriptions(domain string) ([]*models.Subscription, error) {
	rows, err := d.db.Query(`SELECT id, domain, url, events_json, enabled, created_at FROM subscriptions WHERE domain = ? COLLATE NOCASE ORDER BY created_at DESC`, strings.TrimSpace(domain))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*models.Subscription
	for rows.Next() {
		var id, dom, url, eventsJSON string
		var enabled int
		var createdAt int64
		if err := rows.Scan(&id, &dom, &url, &eventsJSON, &enabled, &createdAt); err != nil {
			return nil, err
		}
		var events []string
		_ = json.Unmarshal([]byte(eventsJSON), &events)
		if events == nil {
			events = []string{}
		}
		dateStr := time.Unix(createdAt, 0).Format("2006-01-02")
		out = append(out, &models.Subscription{
			ID:        id,
			Domain:    dom,
			URL:       url,
			Events:    events,
			Enabled:   enabled == 1,
			CreatedAt: dateStr,
		})
	}
	return out, nil
}

func (d *DB) CreateSubscription(domain, url string, events []string) (*models.Subscription, string, error) {
	cleanURL := strings.TrimSpace(url)
	if cleanURL == "" {
		return nil, "", fmt.Errorf("subscription URL required")
	}
	if len(events) == 0 {
		return nil, "", fmt.Errorf("at least one event required")
	}
	eventsJSON, _ := json.Marshal(events)
	id := crypto.GenerateID("sub")
	secret := fmt.Sprintf("whsec_%s%s", crypto.GenerateID("k")[2:], crypto.GenerateID("k")[2:])
	now := time.Now().Unix()

	_, err := d.db.Exec(`INSERT INTO subscriptions (id, domain, url, events_json, secret, enabled, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)`,
		id, strings.TrimSpace(domain), cleanURL, string(eventsJSON), secret, now)
	if err != nil {
		return nil, "", fmt.Errorf("failed to save subscription: %w", err)
	}

	dateStr := time.Unix(now, 0).Format("2006-01-02")
	sub := &models.Subscription{
		ID:        id,
		Domain:    domain,
		URL:       cleanURL,
		Events:    events,
		Enabled:   true,
		CreatedAt: dateStr,
	}
	return sub, secret, nil
}

func (d *DB) UpdateSubscriptionEnabled(id string, enabled bool) (*models.Subscription, error) {
	en := 0
	if enabled {
		en = 1
	}
	_, err := d.db.Exec(`UPDATE subscriptions SET enabled = ? WHERE id = ?`, en, id)
	if err != nil {
		return nil, err
	}
	row := d.db.QueryRow(`SELECT id, domain, url, events_json, enabled, created_at FROM subscriptions WHERE id = ?`, id)
	var subID, dom, url, eventsJSON string
	var enabledVal int
	var createdAt int64
	if err := row.Scan(&subID, &dom, &url, &eventsJSON, &enabledVal, &createdAt); err != nil {
		return nil, err
	}
	var events []string
	_ = json.Unmarshal([]byte(eventsJSON), &events)
	return &models.Subscription{
		ID:        subID,
		Domain:    dom,
		URL:       url,
		Events:    events,
		Enabled:   enabledVal == 1,
		CreatedAt: time.Unix(createdAt, 0).Format("2006-01-02"),
	}, nil
}

func (d *DB) DeleteSubscription(id string) error {
	_, err := d.db.Exec(`DELETE FROM subscriptions WHERE id = ?`, id)
	return err
}

func (d *DB) GetSubscriptionByID(id string) (*models.Subscription, error) {
	row := d.db.QueryRow(`SELECT id, domain, url, events_json, enabled, created_at FROM subscriptions WHERE id = ?`, id)
	var subID, dom, url, eventsJSON string
	var enabledVal int
	var createdAt int64
	if err := row.Scan(&subID, &dom, &url, &eventsJSON, &enabledVal, &createdAt); err != nil {
		return nil, fmt.Errorf("subscription %q not found", id)
	}
	var events []string
	_ = json.Unmarshal([]byte(eventsJSON), &events)
	return &models.Subscription{
		ID:        subID,
		Domain:    dom,
		URL:       url,
		Events:    events,
		Enabled:   enabledVal == 1,
		CreatedAt: time.Unix(createdAt, 0).Format("2006-01-02"),
	}, nil
}

func bytesToMb(b int64) float64 {
	mb := float64(b) / (1024.0 * 1024.0)
	return math.Round(mb*100) / 100
}

func (d *DB) CreateMailbox(domain, local, password, kind string) (*models.Mailbox, error) {
	cleanDomain := strings.ToLower(strings.TrimSpace(domain))
	cleanLocal := strings.ToLower(strings.TrimSpace(local))
	if cleanDomain == "" {
		return nil, fmt.Errorf("domain is required")
	}

	cleanKind := models.MailboxKind(kind)
	if cleanKind != models.MailboxKindSendOnly && cleanKind != models.MailboxKindCatchAll {
		cleanKind = models.MailboxKindStandard
	}

	if cleanKind == models.MailboxKindCatchAll {
		cleanLocal = "catch-all"
	}

	address := fmt.Sprintf("%s@%s", cleanLocal, cleanDomain)

	now := time.Now().Unix()
	id := crypto.GenerateID("mb")
	passHash := ""
	if password != "" {
		passHash = crypto.HashPassword(password)
	}

	if cleanKind == models.MailboxKindCatchAll {
		_, _ = d.db.Exec(`UPDATE mailboxes SET kind = 'standard', updated_at = ? WHERE domain = ? COLLATE NOCASE AND kind = 'catch-all'`, now, cleanDomain)
	}

	query := `
	INSERT INTO mailboxes (id, address, display_name, domain, password_hash, kind, enabled, used_bytes, quota_bytes, created_at, updated_at)
	VALUES (?, ?, '', ?, ?, ?, 1, 0, 0, ?, ?)
	`
	_, err := d.db.Exec(query, id, address, cleanDomain, passHash, string(cleanKind), now, now)
	if err != nil {
		return nil, fmt.Errorf("failed to create mailbox: %w", err)
	}

	return d.GetMailbox(address)
}

func (d *DB) GetMailbox(address string) (*models.Mailbox, error) {
	cleanAddr := strings.ToLower(strings.TrimSpace(address))
	query := `
	SELECT id, address, display_name, domain, password_hash, kind, enabled, used_bytes, quota_bytes, created_at, updated_at
	FROM mailboxes
	WHERE address = ? COLLATE NOCASE
	`
	row := d.db.QueryRow(query, cleanAddr)

	var mb models.Mailbox
	var passHash, kindStr string
	var enabledInt int
	err := row.Scan(
		&mb.ID, &mb.Address, &mb.DisplayName, &mb.Domain, &passHash, &kindStr,
		&enabledInt, &mb.UsedBytes, &mb.QuotaBytes, &mb.CreatedAt, &mb.UpdatedAt,
	)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, fmt.Errorf("mailbox %q not found", address)
		}
		return nil, err
	}
	mb.Kind = models.MailboxKind(kindStr)
	mb.Enabled = enabledInt == 1
	mb.PasswordSet = passHash != ""
	if mb.UsedBytes == 0 {
		var actualBytes int64
		if err := d.db.QueryRow(`SELECT COALESCE(SUM(size_bytes), 0) FROM messages WHERE mailbox = ? COLLATE NOCASE`, cleanAddr).Scan(&actualBytes); err == nil && actualBytes > 0 {
			mb.UsedBytes = actualBytes
			_, _ = d.db.Exec(`UPDATE mailboxes SET used_bytes = ? WHERE address = ? COLLATE NOCASE`, actualBytes, cleanAddr)
		}
	}
	mb.UsedMb = bytesToMb(mb.UsedBytes)
	mb.QuotaMb = bytesToMb(mb.QuotaBytes)

	return &mb, nil
}

func (d *DB) AuthenticateMailbox(address, password string) (*models.Mailbox, error) {
	cleanAddr := strings.ToLower(strings.TrimSpace(address))
	row := d.db.QueryRow(`SELECT password_hash FROM mailboxes WHERE address = ? COLLATE NOCASE AND enabled = 1`, cleanAddr)
	var passHash string
	if err := row.Scan(&passHash); err != nil {
		if err == sql.ErrNoRows {
			return nil, fmt.Errorf("invalid mailbox address or password")
		}
		return nil, err
	}

	if passHash == "" || !crypto.VerifyPassword(password, passHash) {
		return nil, fmt.Errorf("invalid mailbox address or password")
	}

	return d.GetMailbox(cleanAddr)
}

func (d *DB) ListMailboxes(domain string) ([]*models.Mailbox, error) {
	cleanDomain := strings.ToLower(strings.TrimSpace(domain))
	rows, err := d.db.Query(`SELECT id, address, display_name, domain, password_hash, kind, enabled, used_bytes, quota_bytes, created_at, updated_at FROM mailboxes WHERE domain = ? COLLATE NOCASE ORDER BY address ASC`, cleanDomain)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var list []*models.Mailbox
	for rows.Next() {
		var mb models.Mailbox
		var passHash, kindStr string
		var enabledInt int
		if err := rows.Scan(
			&mb.ID, &mb.Address, &mb.DisplayName, &mb.Domain, &passHash, &kindStr,
			&enabledInt, &mb.UsedBytes, &mb.QuotaBytes, &mb.CreatedAt, &mb.UpdatedAt,
		); err != nil {
			return nil, err
		}
		mb.Kind = models.MailboxKind(kindStr)
		mb.Enabled = enabledInt == 1
		mb.PasswordSet = passHash != ""
		mb.UsedMb = bytesToMb(mb.UsedBytes)
		mb.QuotaMb = bytesToMb(mb.QuotaBytes)
		list = append(list, &mb)
	}
	return list, nil
}

func (d *DB) ListAllMailboxes() ([]*models.Mailbox, error) {
	rows, err := d.db.Query(`SELECT id, address, display_name, domain, password_hash, kind, enabled, used_bytes, quota_bytes, created_at, updated_at FROM mailboxes ORDER BY address ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var list []*models.Mailbox
	for rows.Next() {
		var mb models.Mailbox
		var passHash, kindStr string
		var enabledInt int
		if err := rows.Scan(
			&mb.ID, &mb.Address, &mb.DisplayName, &mb.Domain, &passHash, &kindStr,
			&enabledInt, &mb.UsedBytes, &mb.QuotaBytes, &mb.CreatedAt, &mb.UpdatedAt,
		); err != nil {
			return nil, err
		}
		mb.Kind = models.MailboxKind(kindStr)
		mb.Enabled = enabledInt == 1
		mb.PasswordSet = passHash != ""
		mb.UsedMb = bytesToMb(mb.UsedBytes)
		mb.QuotaMb = bytesToMb(mb.QuotaBytes)
		list = append(list, &mb)
	}
	return list, nil
}

func (d *DB) UpdateMailboxPassword(address, password string) error {
	cleanAddr := strings.ToLower(strings.TrimSpace(address))
	passHash := crypto.HashPassword(password)
	now := time.Now().Unix()

	res, err := d.db.Exec(`UPDATE mailboxes SET password_hash = ?, updated_at = ? WHERE address = ? COLLATE NOCASE`, passHash, now, cleanAddr)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("mailbox %q not found", address)
	}
	return nil
}

func (d *DB) UpdateMailboxSettings(address string, enabled *bool, kind *models.MailboxKind, quotaBytes *int64, displayName *string) (*models.Mailbox, error) {
	mb, err := d.GetMailbox(address)
	if err != nil {
		return nil, err
	}

	now := time.Now().Unix()
	if enabled != nil {
		enabledInt := 0
		if *enabled {
			enabledInt = 1
		}
		if _, err := d.db.Exec(`UPDATE mailboxes SET enabled = ?, updated_at = ? WHERE address = ? COLLATE NOCASE`, enabledInt, now, mb.Address); err != nil {
			return nil, err
		}
	}

	if kind != nil {
		cleanKind := *kind
		if cleanKind == models.MailboxKindCatchAll {
			_, _ = d.db.Exec(`UPDATE mailboxes SET kind = 'standard', updated_at = ? WHERE domain = ? COLLATE NOCASE AND kind = 'catch-all'`, now, mb.Domain)
		}
		if _, err := d.db.Exec(`UPDATE mailboxes SET kind = ?, updated_at = ? WHERE address = ? COLLATE NOCASE`, string(cleanKind), now, mb.Address); err != nil {
			return nil, err
		}
	}

	if quotaBytes != nil {
		if *quotaBytes < 0 {
			return nil, fmt.Errorf("quota must be >= 0 (0 = unlimited)")
		}
		if _, err := d.db.Exec(`UPDATE mailboxes SET quota_bytes = ?, updated_at = ? WHERE address = ? COLLATE NOCASE`, *quotaBytes, now, mb.Address); err != nil {
			return nil, err
		}
	}

	if displayName != nil {
		cleanName := strings.TrimSpace(*displayName)
		if _, err := d.db.Exec(`UPDATE mailboxes SET display_name = ?, updated_at = ? WHERE address = ? COLLATE NOCASE`, cleanName, now, mb.Address); err != nil {
			return nil, err
		}
	}

	return d.GetMailbox(address)
}

func (d *DB) DeleteMailbox(address string) error {
	cleanAddr := strings.ToLower(strings.TrimSpace(address))
	_, err := d.db.Exec(`DELETE FROM mailboxes WHERE address = ? COLLATE NOCASE`, cleanAddr)
	return err
}

func (d *DB) AddMailboxUsage(address string, deltaBytes int64) (int64, float64, error) {
	cleanAddr := strings.ToLower(strings.TrimSpace(address))
	now := time.Now().Unix()

	query := `
	UPDATE mailboxes
	SET used_bytes = MAX(0, used_bytes + ?), updated_at = ?
	WHERE address = ? COLLATE NOCASE
	`
	res, err := d.db.Exec(query, deltaBytes, now, cleanAddr)
	if err != nil {
		return 0, 0, err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return 0, 0, fmt.Errorf("mailbox %q not found", address)
	}

	var newUsedBytes int64
	row := d.db.QueryRow(`SELECT used_bytes FROM mailboxes WHERE address = ? COLLATE NOCASE`, cleanAddr)
	if err := row.Scan(&newUsedBytes); err != nil {
		return 0, 0, err
	}

	return newUsedBytes, bytesToMb(newUsedBytes), nil
}

func (d *DB) FindDeliveryMailboxes(toAddress string) ([]*models.Mailbox, error) {
	cleanTo := strings.ToLower(strings.TrimSpace(toAddress))
	mb, err := d.GetMailbox(cleanTo)
	if err == nil && mb != nil && mb.Enabled {
		return []*models.Mailbox{mb}, nil
	}

	parts := strings.Split(cleanTo, "@")
	if len(parts) == 2 {
		domain := parts[1]
		var catchAll models.Mailbox
		var passHash, kindStr string
		var enabledInt int
		row := d.db.QueryRow(`
			SELECT id, address, display_name, domain, password_hash, kind, enabled, used_bytes, quota_bytes, created_at, updated_at
			FROM mailboxes
			WHERE domain = ? COLLATE NOCASE AND kind = 'catch-all' AND enabled = 1
		`, domain)
		if err := row.Scan(
			&catchAll.ID, &catchAll.Address, &catchAll.DisplayName, &catchAll.Domain, &passHash, &kindStr,
			&enabledInt, &catchAll.UsedBytes, &catchAll.QuotaBytes, &catchAll.CreatedAt, &catchAll.UpdatedAt,
		); err == nil {
			catchAll.Kind = models.MailboxKind(kindStr)
			catchAll.Enabled = true
			catchAll.PasswordSet = passHash != ""
			catchAll.UsedMb = bytesToMb(catchAll.UsedBytes)
			catchAll.QuotaMb = bytesToMb(catchAll.QuotaBytes)
			return []*models.Mailbox{&catchAll}, nil
		}
	}

	return nil, nil
}

func (d *DB) CreateMessage(msg *models.StoredMessage) error {
	if msg.ID == "" {
		msg.ID = crypto.GenerateID("msg")
	}
	if msg.CreatedAt == 0 {
		msg.CreatedAt = time.Now().Unix()
	}
	if msg.Date == "" {
		msg.Date = time.Unix(msg.CreatedAt, 0).UTC().Format(time.RFC3339)
	}

	isReadInt := 0
	if msg.Read {
		isReadInt = 1
	}
	isStarredInt := 0
	if msg.Starred {
		isStarredInt = 1
	}
	if msg.SizeBytes <= 0 {
		msg.SizeBytes = int64(len(msg.Subject) + len(msg.Body) + len(msg.BodyHTML) + len(msg.From) + len(msg.To))
		if msg.SizeBytes <= 0 {
			msg.SizeBytes = 256
		}
	}

	query := `
	INSERT INTO messages (
		id, mailbox, folder, from_address, to_address, subject,
		body, body_html, raw_path, size_bytes, is_read, is_starred, created_at
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`
	_, err := d.db.Exec(query,
		msg.ID, strings.ToLower(msg.Mailbox), msg.Folder, msg.From, msg.To,
		msg.Subject, msg.Body, msg.BodyHTML, msg.RawPath, msg.SizeBytes,
		isReadInt, isStarredInt, msg.CreatedAt,
	)
	if err != nil {
		return fmt.Errorf("failed to insert message: %w", err)
	}

	_, _, _ = d.AddMailboxUsage(msg.Mailbox, msg.SizeBytes)

	for _, att := range msg.Attachments {
		att.MessageID = msg.ID
		att.Mailbox = msg.Mailbox
		_ = d.CreateAttachment(att)
	}

	return nil
}

func (d *DB) GetMessage(id string) (*models.StoredMessage, error) {
	query := `
	SELECT id, mailbox, folder, from_address, to_address, subject,
	       body, body_html, raw_path, size_bytes, is_read, is_starred, created_at
	FROM messages
	WHERE id = ?
	`
	row := d.db.QueryRow(query, id)

	var msg models.StoredMessage
	var isReadInt, isStarredInt int
	if err := row.Scan(
		&msg.ID, &msg.Mailbox, &msg.Folder, &msg.From, &msg.To, &msg.Subject,
		&msg.Body, &msg.BodyHTML, &msg.RawPath, &msg.SizeBytes,
		&isReadInt, &isStarredInt, &msg.CreatedAt,
	); err != nil {
		if err == sql.ErrNoRows {
			return nil, fmt.Errorf("message %q not found", id)
		}
		return nil, err
	}

	msg.Read = isReadInt == 1
	msg.Starred = isStarredInt == 1
	msg.Date = time.Unix(msg.CreatedAt, 0).UTC().Format(time.RFC3339)

	d.sanitizeMessageBody(&msg)
	if msg.RawPath != "" && strings.Contains(msg.BodyHTML, "cid:") {

		if rawBytes, err := os.ReadFile(msg.RawPath); err == nil {
			parsed := emailparser.ParseEmail(rawBytes)
			if parsed.HTMLBody != "" && parsed.HTMLBody != msg.BodyHTML {
				msg.BodyHTML = parsed.HTMLBody
				_, _ = d.db.Exec("UPDATE messages SET body_html = ? WHERE id = ?", msg.BodyHTML, msg.ID)
			}
		}
	}

	atts, _ := d.ListAttachmentsForMessage(msg.ID)
	msg.Attachments = atts

	return &msg, nil
}

func (d *DB) sanitizeMessageBody(msg *models.StoredMessage) {
	if msg == nil {
		return
	}
	if msg.BodyHTML == "" && emailparser.IsMultipartOrEncoded(msg.Body) {
		plain, htmlBody := emailparser.ParseBody(msg.Body, "")
		if plain != "" {
			msg.Body = plain
		}
		if htmlBody != "" {
			msg.BodyHTML = htmlBody
		}
	}
}

func (d *DB) ListMessages(mailbox, folder string) ([]*models.StoredMessage, error) {
	cleanMb := strings.ToLower(strings.TrimSpace(mailbox))
	var rows *sql.Rows
	var err error

	if folder == "starred" {
		rows, err = d.db.Query(`
			SELECT id, mailbox, folder, from_address, to_address, subject,
			       body, body_html, raw_path, size_bytes, is_read, is_starred, created_at
			FROM messages
			WHERE mailbox = ? COLLATE NOCASE AND is_starred = 1 AND folder != 'trash'
			ORDER BY created_at DESC
		`, cleanMb)
	} else if folder == "trash" {
		rows, err = d.db.Query(`
			SELECT id, mailbox, folder, from_address, to_address, subject,
			       body, body_html, raw_path, size_bytes, is_read, is_starred, created_at
			FROM messages
			WHERE mailbox = ? COLLATE NOCASE AND folder = 'trash'
			ORDER BY created_at DESC
		`, cleanMb)
	} else {
		targetFolder := folder
		if targetFolder == "" {
			targetFolder = "inbox"
		}
		rows, err = d.db.Query(`
			SELECT id, mailbox, folder, from_address, to_address, subject,
			       body, body_html, raw_path, size_bytes, is_read, is_starred, created_at
			FROM messages
			WHERE mailbox = ? COLLATE NOCASE AND folder = ?
			ORDER BY created_at DESC
		`, cleanMb, targetFolder)
	}

	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var list []*models.StoredMessage
	for rows.Next() {
		var msg models.StoredMessage
		var isReadInt, isStarredInt int
		if err := rows.Scan(
			&msg.ID, &msg.Mailbox, &msg.Folder, &msg.From, &msg.To, &msg.Subject,
			&msg.Body, &msg.BodyHTML, &msg.RawPath, &msg.SizeBytes,
			&isReadInt, &isStarredInt, &msg.CreatedAt,
		); err != nil {
			return nil, err
		}
		msg.Read = isReadInt == 1
		msg.Starred = isStarredInt == 1
		msg.Date = time.Unix(msg.CreatedAt, 0).UTC().Format(time.RFC3339)
		msg.Attachments = []*models.Attachment{}
		d.sanitizeMessageBody(&msg)
		list = append(list, &msg)
	}
	_ = rows.Close()

	if len(list) > 0 {
		msgMap := make(map[string]*models.StoredMessage, len(list))
		for _, m := range list {
			msgMap[m.ID] = m
		}

		const batchSize = 200
		for i := 0; i < len(list); i += batchSize {
			end := i + batchSize
			if end > len(list) {
				end = len(list)
			}
			batch := list[i:end]
			placeholders := make([]string, len(batch))
			args := make([]interface{}, len(batch))
			for j, m := range batch {
				placeholders[j] = "?"
				args[j] = m.ID
			}

			attQuery := fmt.Sprintf(`
				SELECT id, message_id, mailbox, filename, content_type, size_bytes, storage_path, sha256, created_at,
				       COALESCE(content_id, ''), COALESCE(is_inline, 0)
				FROM attachments
				WHERE message_id IN (%s)
				ORDER BY created_at ASC
			`, strings.Join(placeholders, ","))

			if attRows, err := d.db.Query(attQuery, args...); err == nil {
				for attRows.Next() {
					var att models.Attachment
					var isInlineInt int
					if err := attRows.Scan(&att.ID, &att.MessageID, &att.Mailbox, &att.Filename, &att.ContentType, &att.SizeBytes, &att.StoragePath, &att.SHA256, &att.CreatedAt, &att.ContentID, &isInlineInt); err == nil {
						att.IsInline = isInlineInt == 1
						if m, ok := msgMap[att.MessageID]; ok {
							m.Attachments = append(m.Attachments, &att)
						}
					}
				}
				_ = attRows.Close()
			}
		}
	}

	return list, nil
}

func (d *DB) UpdateMessageRead(id string, read bool) error {
	readInt := 0
	if read {
		readInt = 1
	}
	_, err := d.db.Exec(`UPDATE messages SET is_read = ? WHERE id = ?`, readInt, id)
	return err
}

func (d *DB) UpdateMessageStarred(id string, starred bool) error {
	starredInt := 0
	if starred {
		starredInt = 1
	}
	_, err := d.db.Exec(`UPDATE messages SET is_starred = ? WHERE id = ?`, starredInt, id)
	return err
}

func (d *DB) MoveMessageFolder(id, folder string) error {
	_, err := d.db.Exec(`UPDATE messages SET folder = ? WHERE id = ?`, folder, id)
	return err
}

func (d *DB) DeleteMessage(id string) (*models.StoredMessage, error) {
	msg, err := d.GetMessage(id)
	if err != nil {
		return nil, err
	}

	_, _ = d.db.Exec(`DELETE FROM attachments WHERE message_id = ?`, id)
	_, err = d.db.Exec(`DELETE FROM messages WHERE id = ?`, id)
	if err != nil {
		return nil, err
	}

	_, _, _ = d.AddMailboxUsage(msg.Mailbox, -msg.SizeBytes)

	return msg, nil
}

func (d *DB) ClearMessages(mailbox, folder string) ([]*models.StoredMessage, error) {
	cleanMb := strings.ToLower(strings.TrimSpace(mailbox))
	if cleanMb == "" {
		return nil, fmt.Errorf("mailbox address required")
	}
	cleanFolder := strings.ToLower(strings.TrimSpace(folder))
	if cleanFolder == "" {
		cleanFolder = "inbox"
	}

	tx, err := d.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	var rows *sql.Rows
	if cleanFolder == "all" || cleanFolder == "*" {
		rows, err = tx.Query(`SELECT id, mailbox, folder, raw_path, size_bytes FROM messages WHERE mailbox = ? COLLATE NOCASE`, cleanMb)
	} else {
		rows, err = tx.Query(`SELECT id, mailbox, folder, raw_path, size_bytes FROM messages WHERE mailbox = ? COLLATE NOCASE AND folder = ?`, cleanMb, cleanFolder)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var deleted []*models.StoredMessage
	var totalFreedBytes int64
	for rows.Next() {
		var m models.StoredMessage
		if err := rows.Scan(&m.ID, &m.Mailbox, &m.Folder, &m.RawPath, &m.SizeBytes); err != nil {
			return nil, err
		}
		deleted = append(deleted, &m)
		totalFreedBytes += m.SizeBytes
	}
	_ = rows.Close()

	if len(deleted) == 0 {
		return []*models.StoredMessage{}, nil
	}

	if cleanFolder == "all" || cleanFolder == "*" {
		_, _ = tx.Exec(`DELETE FROM attachments WHERE mailbox = ? COLLATE NOCASE`, cleanMb)
		if _, err := tx.Exec(`DELETE FROM messages WHERE mailbox = ? COLLATE NOCASE`, cleanMb); err != nil {
			return nil, err
		}
	} else {
		_, _ = tx.Exec(`DELETE FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE mailbox = ? COLLATE NOCASE AND folder = ?)`, cleanMb, cleanFolder)
		if _, err := tx.Exec(`DELETE FROM messages WHERE mailbox = ? COLLATE NOCASE AND folder = ?`, cleanMb, cleanFolder); err != nil {
			return nil, err
		}
	}

	now := time.Now().Unix()
	_, _ = tx.Exec(`UPDATE mailboxes SET used_bytes = MAX(0, used_bytes - ?), updated_at = ? WHERE address = ? COLLATE NOCASE`, totalFreedBytes, now, cleanMb)

	if err := tx.Commit(); err != nil {
		return nil, err
	}

	return deleted, nil
}

func (d *DB) DeleteMailboxMessagesByIDs(mailbox string, ids []string) ([]*models.StoredMessage, error) {
	cleanMb := strings.ToLower(strings.TrimSpace(mailbox))
	if cleanMb == "" {
		return nil, fmt.Errorf("mailbox address required")
	}
	if len(ids) == 0 {
		return []*models.StoredMessage{}, nil
	}

	seen := make(map[string]bool)
	var cleanIDs []string
	for _, id := range ids {
		trimmed := strings.TrimSpace(id)
		if trimmed != "" && !seen[trimmed] {
			seen[trimmed] = true
			cleanIDs = append(cleanIDs, trimmed)
		}
	}
	if len(cleanIDs) == 0 {
		return []*models.StoredMessage{}, nil
	}

	tx, err := d.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	var deleted []*models.StoredMessage
	var totalFreedBytes int64

	const batchSize = 200
	for i := 0; i < len(cleanIDs); i += batchSize {
		end := i + batchSize
		if end > len(cleanIDs) {
			end = len(cleanIDs)
		}
		batch := cleanIDs[i:end]

		placeholders := make([]string, len(batch))
		queryArgs := make([]interface{}, 0, len(batch)+1)
		queryArgs = append(queryArgs, cleanMb)
		for j, id := range batch {
			placeholders[j] = "?"
			queryArgs = append(queryArgs, id)
		}
		phStr := strings.Join(placeholders, ",")

		query := fmt.Sprintf(`SELECT id, mailbox, folder, raw_path, size_bytes FROM messages WHERE mailbox = ? COLLATE NOCASE AND id IN (%s)`, phStr)
		rows, err := tx.Query(query, queryArgs...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var m models.StoredMessage
			if err := rows.Scan(&m.ID, &m.Mailbox, &m.Folder, &m.RawPath, &m.SizeBytes); err != nil {
				rows.Close()
				return nil, err
			}
			deleted = append(deleted, &m)
			totalFreedBytes += m.SizeBytes
		}
		_ = rows.Close()

		delAttQuery := fmt.Sprintf(`DELETE FROM attachments WHERE message_id IN (%s)`, phStr)
		attArgs := make([]interface{}, len(batch))
		for j, id := range batch {
			attArgs[j] = id
		}
		_, _ = tx.Exec(delAttQuery, attArgs...)

		delQuery := fmt.Sprintf(`DELETE FROM messages WHERE mailbox = ? COLLATE NOCASE AND id IN (%s)`, phStr)
		if _, err := tx.Exec(delQuery, queryArgs...); err != nil {
			return nil, err
		}
	}

	if len(deleted) > 0 {
		now := time.Now().Unix()
		_, _ = tx.Exec(`UPDATE mailboxes SET used_bytes = MAX(0, used_bytes - ?), updated_at = ? WHERE address = ? COLLATE NOCASE`, totalFreedBytes, now, cleanMb)
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}

	return deleted, nil
}

func (d *DB) CreateAttachment(att *models.Attachment) error {
	if att.ID == "" {
		att.ID = crypto.GenerateID("att")
	}
	if att.CreatedAt == 0 {
		att.CreatedAt = time.Now().Unix()
	}
	isInlineInt := 0
	if att.IsInline {
		isInlineInt = 1
	}

	query := `
	INSERT INTO attachments (id, message_id, mailbox, filename, content_type, size_bytes, storage_path, sha256, created_at, content_id, is_inline)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`
	_, err := d.db.Exec(query, att.ID, att.MessageID, strings.ToLower(att.Mailbox), att.Filename, att.ContentType, att.SizeBytes, att.StoragePath, att.SHA256, att.CreatedAt, att.ContentID, isInlineInt)
	return err
}

func (d *DB) GetAttachment(id string) (*models.Attachment, error) {
	query := `
	SELECT id, message_id, mailbox, filename, content_type, size_bytes, storage_path, sha256, created_at,
	       COALESCE(content_id, ''), COALESCE(is_inline, 0)
	FROM attachments
	WHERE id = ?
	`
	row := d.db.QueryRow(query, id)
	var att models.Attachment
	var isInlineInt int
	if err := row.Scan(&att.ID, &att.MessageID, &att.Mailbox, &att.Filename, &att.ContentType, &att.SizeBytes, &att.StoragePath, &att.SHA256, &att.CreatedAt, &att.ContentID, &isInlineInt); err != nil {
		if err == sql.ErrNoRows {
			return nil, fmt.Errorf("attachment %q not found", id)
		}
		return nil, err
	}
	att.IsInline = isInlineInt == 1
	return &att, nil
}

func (d *DB) ListAttachmentsForMessage(messageID string) ([]*models.Attachment, error) {
	query := `
	SELECT id, message_id, mailbox, filename, content_type, size_bytes, storage_path, sha256, created_at,
	       COALESCE(content_id, ''), COALESCE(is_inline, 0)
	FROM attachments
	WHERE message_id = ?
	ORDER BY created_at ASC
	`
	rows, err := d.db.Query(query, messageID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var list []*models.Attachment
	for rows.Next() {
		var att models.Attachment
		var isInlineInt int
		if err := rows.Scan(&att.ID, &att.MessageID, &att.Mailbox, &att.Filename, &att.ContentType, &att.SizeBytes, &att.StoragePath, &att.SHA256, &att.CreatedAt, &att.ContentID, &isInlineInt); err != nil {
			return nil, err
		}
		att.IsInline = isInlineInt == 1
		list = append(list, &att)
	}
	return list, nil
}
