package usermanager

import (
	"archive/zip"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"mailer-go/backend/server/pkg/db"
	"mailer-go/backend/server/pkg/storage"
	"mailer-go/backend/shared/crypto"
	_ "modernc.org/sqlite"
)

type User struct {
	ID        string `json:"id"`
	Email     string `json:"email"`
	Plan      int    `json:"plan"`
	Status    string `json:"status"`
	Token     string `json:"token,omitempty"`
	CreatedAt int64  `json:"created_at"`
	UpdatedAt int64  `json:"updated_at"`
}

type UserManager struct {
	mu           sync.RWMutex
	centralDB    *sql.DB
	baseUsersDir string
	adminEmail   string
	mode         string
	userDBs      map[string]*db.DB
	userStorages map[string]*storage.Storage
}

func New(centralDBPath, baseUsersDir, adminEmail, mode string) (*UserManager, error) {
	if centralDBPath == "" {
		centralDBPath = "central_backend.db"
	}
	if baseUsersDir == "" {
		baseUsersDir = "data/users"
	}

	cleanMode := strings.ToLower(strings.TrimSpace(mode))
	if cleanMode == "" {
		cleanMode = "live"
	}

	if err := os.MkdirAll(baseUsersDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create base users dir: %w", err)
	}

	dsn := fmt.Sprintf("%s?_pragma=busy_timeout(10000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)", centralDBPath)
	centralDB, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("failed to open central auth db: %w", err)
	}
	centralDB.SetMaxOpenConns(10)
	centralDB.SetMaxIdleConns(5)

	mgr := &UserManager{
		centralDB:    centralDB,
		baseUsersDir: baseUsersDir,
		adminEmail:   strings.ToLower(strings.TrimSpace(adminEmail)),
		mode:         cleanMode,
		userDBs:      make(map[string]*db.DB),
		userStorages: make(map[string]*storage.Storage),
	}

	if err := mgr.migrate(); err != nil {
		_ = centralDB.Close()
		return nil, fmt.Errorf("failed to migrate auth db: %w", err)
	}

	return mgr, nil
}

func (m *UserManager) Close() error {
	m.mu.Lock()
	defer m.mu.Unlock()

	for _, udb := range m.userDBs {
		_ = udb.Close()
	}
	return m.centralDB.Close()
}

func (m *UserManager) migrate() error {
	schema := `
	CREATE TABLE IF NOT EXISTS users (
		id TEXT PRIMARY KEY,
		email TEXT NOT NULL UNIQUE COLLATE NOCASE,
		password_hash TEXT NOT NULL,
		plan INTEGER NOT NULL DEFAULT 0,
		status TEXT NOT NULL DEFAULT 'approved',
		auth_token TEXT NOT NULL UNIQUE,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_users_token ON users(auth_token);
	CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
	CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

	CREATE TABLE IF NOT EXISTS domain_owners (
		domain TEXT PRIMARY KEY COLLATE NOCASE,
		user_id TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
	);
	CREATE INDEX IF NOT EXISTS idx_domain_owners_user ON domain_owners(user_id);

	CREATE TABLE IF NOT EXISTS mailbox_sessions (
		token TEXT PRIMARY KEY,
		address TEXT NOT NULL COLLATE NOCASE,
		created_at INTEGER NOT NULL,
		expires_at INTEGER NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_mbx_sess_token ON mailbox_sessions(token);
	CREATE INDEX IF NOT EXISTS idx_mbx_sess_addr ON mailbox_sessions(address);
	`
	if _, err := m.centralDB.Exec(schema); err != nil {
		return err
	}

	if m.adminEmail != "" {
		_, _ = m.centralDB.Exec(`UPDATE users SET plan = 1, status = 'approved' WHERE email = ? COLLATE NOCASE`, m.adminEmail)
	}

	return nil
}

func generateToken() string {
	b := make([]byte, 24)
	_, _ = rand.Read(b)
	return fmt.Sprintf("mg_sess_%s", hex.EncodeToString(b))
}

func generateMailboxToken() string {
	b := make([]byte, 24)
	_, _ = rand.Read(b)
	return fmt.Sprintf("mg_mbx_%s", hex.EncodeToString(b))
}

func (m *UserManager) Signup(email, password string) (*User, error) {
	cleanEmail := strings.ToLower(strings.TrimSpace(email))
	if cleanEmail == "" || !strings.Contains(cleanEmail, "@") {
		return nil, fmt.Errorf("valid email address required")
	}
	if len(password) < 6 {
		return nil, fmt.Errorf("password must be at least 6 characters")
	}

	isAdmin := m.adminEmail != "" && cleanEmail == m.adminEmail
	isLocal := m.mode == "local"

	plan := 0
	status := "pending"

	if isAdmin || isLocal {
		plan = 1
		status = "approved"
	}

	now := time.Now().Unix()
	userID := crypto.GenerateID("usr")
	token := generateToken()
	passHash := crypto.HashPassword(password)

	query := `
	INSERT INTO users (id, email, password_hash, plan, status, auth_token, created_at, updated_at)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`
	_, err := m.centralDB.Exec(query, userID, cleanEmail, passHash, plan, status, token, now, now)
	if err != nil {
		return nil, fmt.Errorf("email already registered")
	}

	userDir := m.GetUserDir(userID)
	if err := os.MkdirAll(userDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create user directory: %w", err)
	}

	_, _ = m.GetUserDB(userID)
	_, _ = m.GetUserStorage(userID)

	returnUserToken := token
	if status == "pending" {
		returnUserToken = ""
	}

	return &User{
		ID:        userID,
		Email:     cleanEmail,
		Plan:      plan,
		Status:    status,
		Token:     returnUserToken,
		CreatedAt: now,
		UpdatedAt: now,
	}, nil
}

func (m *UserManager) Login(email, password string) (*User, error) {
	cleanEmail := strings.ToLower(strings.TrimSpace(email))
	row := m.centralDB.QueryRow(`
		SELECT id, email, password_hash, plan, status, auth_token, created_at, updated_at
		FROM users
		WHERE email = ? COLLATE NOCASE
	`, cleanEmail)

	var u User
	var passHash string
	if err := row.Scan(&u.ID, &u.Email, &passHash, &u.Plan, &u.Status, &u.Token, &u.CreatedAt, &u.UpdatedAt); err != nil {
		if err == sql.ErrNoRows {
			return nil, fmt.Errorf("invalid email or password")
		}
		return nil, err
	}

	if !crypto.VerifyPassword(password, passHash) {
		return nil, fmt.Errorf("invalid email or password")
	}

	if m.adminEmail != "" && u.Email == m.adminEmail {
		if u.Plan != 1 || u.Status != "approved" {
			u.Plan = 1
			u.Status = "approved"
			_, _ = m.centralDB.Exec(`UPDATE users SET plan = 1, status = 'approved' WHERE id = ?`, u.ID)
		}
	} else if m.mode == "local" {
		if u.Plan != 1 || u.Status != "approved" {
			u.Plan = 1
			u.Status = "approved"
			_, _ = m.centralDB.Exec(`UPDATE users SET plan = 1, status = 'approved' WHERE id = ?`, u.ID)
		}
	}

	if u.Status == "pending" {
		return nil, fmt.Errorf("Your account is pending administrator approval before you can log in.")
	}
	if u.Status == "blocked" {
		return nil, fmt.Errorf("Your account has been suspended or blocked by an administrator.")
	}

	return &u, nil
}

func (m *UserManager) AuthenticateToken(token string) (*User, error) {
	cleanToken := strings.TrimSpace(token)
	if cleanToken == "" {
		return nil, fmt.Errorf("missing authorization token")
	}

	row := m.centralDB.QueryRow(`
		SELECT id, email, plan, status, auth_token, created_at, updated_at
		FROM users
		WHERE auth_token = ?
	`, cleanToken)

	var u User
	if err := row.Scan(&u.ID, &u.Email, &u.Plan, &u.Status, &u.Token, &u.CreatedAt, &u.UpdatedAt); err != nil {
		if err == sql.ErrNoRows {
			return nil, fmt.Errorf("invalid or expired session token")
		}
		return nil, err
	}

	if m.adminEmail != "" && u.Email == m.adminEmail && (u.Plan != 1 || u.Status != "approved") {
		u.Plan = 1
		u.Status = "approved"
		_, _ = m.centralDB.Exec(`UPDATE users SET plan = 1, status = 'approved' WHERE id = ?`, u.ID)
	}

	if u.Status != "approved" {
		return nil, fmt.Errorf("account not approved or blocked")
	}

	return &u, nil
}

func (m *UserManager) Logout(token string) error {
	newToken := generateToken()
	_, err := m.centralDB.Exec(`UPDATE users SET auth_token = ? WHERE auth_token = ?`, newToken, token)
	return err
}

func (m *UserManager) GetUserByID(userID string) (*User, error) {
	row := m.centralDB.QueryRow(`
		SELECT id, email, plan, status, auth_token, created_at, updated_at
		FROM users
		WHERE id = ?
	`, userID)

	var u User
	if err := row.Scan(&u.ID, &u.Email, &u.Plan, &u.Status, &u.Token, &u.CreatedAt, &u.UpdatedAt); err != nil {
		return nil, err
	}
	return &u, nil
}

type AdminUserInfo struct {
	ID             string `json:"id"`
	Email          string `json:"email"`
	Plan           int    `json:"plan"`
	Status         string `json:"status"`
	CreatedAt      int64  `json:"created_at"`
	UpdatedAt      int64  `json:"updated_at"`
	DomainsCount   int    `json:"domains_count"`
	MailboxesCount int    `json:"mailboxes_count"`
	IsAdmin        bool   `json:"is_admin"`
}

func (m *UserManager) ListUsers() ([]AdminUserInfo, error) {
	rows, err := m.centralDB.Query(`
		SELECT id, email, plan, status, created_at, updated_at
		FROM users
		ORDER BY created_at DESC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var list []AdminUserInfo
	for rows.Next() {
		var item AdminUserInfo
		if err := rows.Scan(&item.ID, &item.Email, &item.Plan, &item.Status, &item.CreatedAt, &item.UpdatedAt); err != nil {
			continue
		}
		item.IsAdmin = m.adminEmail != "" && strings.EqualFold(item.Email, m.adminEmail)
		list = append(list, item)
	}
	_ = rows.Close()

	for i := range list {
		_ = m.centralDB.QueryRow(`SELECT COUNT(*) FROM domain_owners WHERE user_id = ?`, list[i].ID).Scan(&list[i].DomainsCount)

		if udb, err := m.GetUserDB(list[i].ID); err == nil {
			if boxes, err := udb.ListAllMailboxes(); err == nil {
				list[i].MailboxesCount = len(boxes)
			}
		}
	}
	return list, nil
}

func (m *UserManager) SetUserStatus(userID, newStatus string) error {
	newStatus = strings.ToLower(strings.TrimSpace(newStatus))
	if newStatus != "approved" && newStatus != "blocked" && newStatus != "pending" {
		return fmt.Errorf("invalid status: %s (must be approved, blocked, or pending)", newStatus)
	}

	user, err := m.GetUserByID(userID)
	if err != nil {
		return fmt.Errorf("user not found: %w", err)
	}

	if m.adminEmail != "" && strings.EqualFold(user.Email, m.adminEmail) {
		return fmt.Errorf("cannot modify status of primary administrator")
	}

	now := time.Now().Unix()
	if newStatus == "blocked" {
		newToken := generateToken()
		_, err = m.centralDB.Exec(`UPDATE users SET status = ?, auth_token = ?, updated_at = ? WHERE id = ?`, newStatus, newToken, now, userID)
	} else {
		_, err = m.centralDB.Exec(`UPDATE users SET status = ?, updated_at = ? WHERE id = ?`, newStatus, now, userID)
	}
	return err
}

func (m *UserManager) DeleteUser(userID string) error {
	user, err := m.GetUserByID(userID)
	if err != nil {
		return fmt.Errorf("user not found: %w", err)
	}

	if m.adminEmail != "" && strings.EqualFold(user.Email, m.adminEmail) {
		return fmt.Errorf("cannot delete primary administrator")
	}

	_, _ = m.centralDB.Exec(`DELETE FROM domain_owners WHERE user_id = ?`, userID)

	m.mu.Lock()
	if udb, ok := m.userDBs[userID]; ok {
		_ = udb.Close()
		delete(m.userDBs, userID)
	}
	delete(m.userStorages, userID)
	m.mu.Unlock()

	_, err = m.centralDB.Exec(`DELETE FROM users WHERE id = ?`, userID)

	userDir := m.GetUserDir(userID)
	_ = os.RemoveAll(userDir)

	return err
}

func (m *UserManager) CreateMailboxSession(address string) (string, error) {
	clean := strings.ToLower(strings.TrimSpace(address))
	if clean == "" {
		return "", fmt.Errorf("mailbox address required")
	}
	token := generateMailboxToken()
	now := time.Now().Unix()
	expiresAt := now + 7*24*3600

	_, _ = m.centralDB.Exec(`DELETE FROM mailbox_sessions WHERE expires_at <= ?`, now)

	_, err := m.centralDB.Exec(`
		INSERT INTO mailbox_sessions (token, address, created_at, expires_at)
		VALUES (?, ?, ?, ?)
	`, token, clean, now, expiresAt)
	if err != nil {
		return "", fmt.Errorf("failed to create mailbox session: %w", err)
	}
	return token, nil
}

func (m *UserManager) AuthenticateMailboxSession(token string) (string, error) {
	cleanToken := strings.TrimSpace(token)
	if cleanToken == "" {
		return "", fmt.Errorf("missing mailbox session token")
	}
	now := time.Now().Unix()
	var address string
	var expiresAt int64
	err := m.centralDB.QueryRow(`
		SELECT address, expires_at
		FROM mailbox_sessions
		WHERE token = ?
	`, cleanToken).Scan(&address, &expiresAt)
	if err != nil {
		if err == sql.ErrNoRows {
			return "", fmt.Errorf("invalid or expired mailbox session token")
		}
		return "", err
	}
	if expiresAt <= now {
		_, _ = m.centralDB.Exec(`DELETE FROM mailbox_sessions WHERE token = ?`, cleanToken)
		return "", fmt.Errorf("mailbox session token expired")
	}
	return address, nil
}

func (m *UserManager) RevokeMailboxSessionsForAddress(address string) error {
	clean := strings.ToLower(strings.TrimSpace(address))
	if clean == "" {
		return nil
	}
	_, err := m.centralDB.Exec(`DELETE FROM mailbox_sessions WHERE address = ? COLLATE NOCASE`, clean)
	return err
}

func (m *UserManager) GetUserDir(userID string) string {
	return filepath.Join(m.baseUsersDir, userID)
}

func (m *UserManager) GetUserDB(userID string) (*db.DB, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if udb, ok := m.userDBs[userID]; ok {
		return udb, nil
	}

	userDir := filepath.Join(m.baseUsersDir, userID)
	if err := os.MkdirAll(userDir, 0755); err != nil {
		return nil, err
	}

	dbPath := filepath.Join(userDir, "data.db")
	udb, err := db.New(dbPath)
	if err != nil {
		return nil, fmt.Errorf("failed to open user db for %s: %w", userID, err)
	}

	m.userDBs[userID] = udb
	return udb, nil
}

func (m *UserManager) GetUserStorage(userID string) (*storage.Storage, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if s, ok := m.userStorages[userID]; ok {
		return s, nil
	}

	storageDir := filepath.Join(m.baseUsersDir, userID, "storage")
	s, err := storage.NewStorage(storageDir)
	if err != nil {
		return nil, fmt.Errorf("failed to open user storage for %s: %w", userID, err)
	}

	m.userStorages[userID] = s
	return s, nil
}

func (m *UserManager) AssociateDomain(domain, userID string) error {
	now := time.Now().Unix()
	_, err := m.centralDB.Exec(`
		INSERT INTO domain_owners (domain, user_id, created_at)
		VALUES (?, ?, ?)
		ON CONFLICT(domain) DO UPDATE SET user_id = excluded.user_id
	`, strings.ToLower(strings.TrimSpace(domain)), userID, now)
	return err
}

func (m *UserManager) DisassociateDomain(domain string) error {
	_, err := m.centralDB.Exec(`DELETE FROM domain_owners WHERE domain = ? COLLATE NOCASE`, strings.ToLower(strings.TrimSpace(domain)))
	return err
}

func (m *UserManager) GetUserIDByDomain(domain string) (string, error) {
	var userID string
	err := m.centralDB.QueryRow(`SELECT user_id FROM domain_owners WHERE domain = ? COLLATE NOCASE`, strings.ToLower(strings.TrimSpace(domain))).Scan(&userID)
	if err != nil {
		if err == sql.ErrNoRows {
			return "", fmt.Errorf("domain %q not registered to any user", domain)
		}
		return "", err
	}
	return userID, nil
}

func (m *UserManager) GetDomainsByUserID(userID string) ([]string, error) {
	rows, err := m.centralDB.Query(`SELECT domain FROM domain_owners WHERE user_id = ?`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var domains []string
	for rows.Next() {
		var dom string
		if err := rows.Scan(&dom); err == nil {
			domains = append(domains, dom)
		}
	}
	return domains, nil
}

func (m *UserManager) ExportUserDataZip(userID string, w io.Writer) error {
	userDir := m.GetUserDir(userID)
	if _, err := os.Stat(userDir); os.IsNotExist(err) {
		return fmt.Errorf("user data directory not found")
	}

	if udb, err := m.GetUserDB(userID); err == nil {
		_, _ = udb.GetDomain("")
	}
	_, _ = m.centralDB.Exec("PRAGMA wal_checkpoint(PASSIVE);")

	zw := zip.NewWriter(w)
	defer zw.Close()

	err := filepath.Walk(userDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		relPath, err := filepath.Rel(userDir, path)
		if err != nil {
			return err
		}
		if relPath == "." {
			return nil
		}

		zipPath := filepath.ToSlash(relPath)

		if info.IsDir() {
			_, err = zw.Create(zipPath + "/")
			return err
		}

		zipFile, err := zw.Create(zipPath)
		if err != nil {
			return err
		}

		srcFile, err := os.Open(path)
		if err != nil {
			log.Printf("[EXPORT WARNING] Could not read file %s: %v", path, err)
			return nil
		}

		_, copyErr := io.Copy(zipFile, srcFile)
		_ = srcFile.Close()
		return copyErr
	})

	return err
}

func (m *UserManager) SyncAllUserDomainsToCentralDB(centralDB *db.DB) error {
	rows, err := m.centralDB.Query("SELECT DISTINCT user_id FROM domain_owners")
	if err != nil {
		return err
	}
	defer rows.Close()

	var userIDs []string
	for rows.Next() {
		var uid string
		if err := rows.Scan(&uid); err == nil {
			userIDs = append(userIDs, uid)
		}
	}

	for _, uid := range userIDs {
		udb, err := m.GetUserDB(uid)
		if err != nil {
			continue
		}
		doms, err := udb.ListDomains()
		if err != nil {
			continue
		}
		for _, d := range doms {
			_ = centralDB.UpsertDomain(d)
		}
	}
	return nil
}
