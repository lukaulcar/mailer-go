package spool

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"sync"
	"time"

	"mailer-go/backend/shared/models"
	_ "modernc.org/sqlite"
)

var ErrSpoolFull = errors.New("spool capacity exceeded: storage quota reached")

type SpoolStats struct {
	RAMUsedBytes    int64 `json:"ram_used_bytes"`
	RAMMaxBytes     int64 `json:"ram_max_bytes"`
	RAMCount        int   `json:"ram_count"`
	SQLiteCount     int   `json:"sqlite_count"`
	DiskMaxBytes    int64 `json:"disk_max_bytes"`
	DiskMaxMessages int   `json:"disk_max_messages"`
}

type SpoolManager struct {
	mu              sync.Mutex
	ramQueue        []*models.MailMessage
	ramUsedBytes    int64
	ramMaxBytes     int64
	maxDiskBytes    int64
	maxDiskMessages int
	db              *sql.DB
	stopPrune       chan struct{}
}

func NewSpoolManager(maxRAMMB, maxDiskMB int64, maxDiskMessages int, sqlitePath string) (*SpoolManager, error) {
	db, err := sql.Open("sqlite", sqlitePath)
	if err != nil {
		return nil, fmt.Errorf("failed to open sqlite database: %w", err)
	}
	db.SetMaxOpenConns(1)

	_, _ = db.Exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000; PRAGMA synchronous=NORMAL;`)

	query := `
	CREATE TABLE IF NOT EXISTS spool_messages (
		id TEXT PRIMARY KEY,
		created_at INTEGER NOT NULL,
		payload TEXT NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_spool_created ON spool_messages(created_at);
	`
	if _, err := db.Exec(query); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("failed to initialize sqlite spool table: %w", err)
	}

	if maxDiskMB <= 0 {
		maxDiskMB = 500
	}
	if maxDiskMessages <= 0 {
		maxDiskMessages = 10000
	}

	mgr := &SpoolManager{
		ramQueue:        make([]*models.MailMessage, 0),
		ramUsedBytes:    0,
		ramMaxBytes:     maxRAMMB * 1024 * 1024,
		maxDiskBytes:    maxDiskMB * 1024 * 1024,
		maxDiskMessages: maxDiskMessages,
		db:              db,
		stopPrune:       make(chan struct{}),
	}

	_, _ = mgr.PruneExpired(7 * 24 * time.Hour)

	go mgr.startPruneLoop(7 * 24 * time.Hour)

	return mgr, nil
}

func (s *SpoolManager) Enqueue(msg *models.MailMessage) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	msgSize := msg.SizeBytes
	if msgSize <= 0 {
		msgSize = int64(len(msg.Raw) + len(msg.Body) + len(msg.Subject) + 128)
		msg.SizeBytes = msgSize
	}

	if s.ramUsedBytes+msgSize <= s.ramMaxBytes {
		s.ramQueue = append(s.ramQueue, msg)
		s.ramUsedBytes += msgSize
		log.Printf("[SPOOL] Buffered mail %s in RAM (%d bytes, RAM used: %d/%d bytes)",
			msg.ID, msgSize, s.ramUsedBytes, s.ramMaxBytes)
		return true, nil
	}

	var (
		currentCount int
		currentBytes sql.NullInt64
	)
	row := s.db.QueryRow(`SELECT COUNT(*), SUM(LENGTH(payload)) FROM spool_messages`)
	_ = row.Scan(&currentCount, &currentBytes)

	data, err := json.Marshal(msg)
	if err != nil {
		return false, fmt.Errorf("failed to marshal mail for sqlite spool: %w", err)
	}

	payloadSize := int64(len(data))
	diskBytes := int64(0)
	if currentBytes.Valid {
		diskBytes = currentBytes.Int64
	}

	if currentCount >= s.maxDiskMessages || diskBytes+payloadSize > s.maxDiskBytes {
		log.Printf("[SPOOL EXHAUSTION] Rejected mail %s: Disk quota reached (%d/%d msgs, %d/%d bytes).",
			msg.ID, currentCount, s.maxDiskMessages, diskBytes, s.maxDiskBytes)
		return false, ErrSpoolFull
	}

	insertSQL := `INSERT INTO spool_messages (id, created_at, payload) VALUES (?, ?, ?)`
	_, err = s.db.Exec(insertSQL, msg.ID, msg.CreatedAt.UnixNano(), string(data))
	if err != nil {
		return false, fmt.Errorf("failed to write mail to sqlite failover spool: %w", err)
	}

	log.Printf("[SPOOL] RAM limit reached. Saved mail %s to SQLite failover (Disk: %d/%d msgs).",
		msg.ID, currentCount+1, s.maxDiskMessages)
	return false, nil
}

func (s *SpoolManager) DequeueBatch(limit int) ([]*models.MailMessage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	var result []*models.MailMessage

	for len(s.ramQueue) > 0 && len(result) < limit {
		msg := s.ramQueue[0]
		s.ramQueue = s.ramQueue[1:]
		s.ramUsedBytes -= msg.SizeBytes
		if s.ramUsedBytes < 0 {
			s.ramUsedBytes = 0
		}
		result = append(result, msg)
	}

	remaining := limit - len(result)
	if remaining > 0 {
		rows, err := s.db.Query(`SELECT id, payload FROM spool_messages ORDER BY created_at ASC LIMIT ?`, remaining)
		if err == nil {
			var idsToDelete []string
			for rows.Next() {
				var id, payload string
				if err := rows.Scan(&id, &payload); err == nil {
					var msg models.MailMessage
					if err := json.Unmarshal([]byte(payload), &msg); err == nil {
						result = append(result, &msg)
						idsToDelete = append(idsToDelete, id)
					} else {
						log.Printf("[SPOOL WARNING] Corrupt spool message %s removed: %v", id, err)
						idsToDelete = append(idsToDelete, id)
					}
				}
			}
			_ = rows.Close()

			for _, id := range idsToDelete {
				_, _ = s.db.Exec(`DELETE FROM spool_messages WHERE id = ?`, id)
			}
		}
	}

	return result, nil
}

func (s *SpoolManager) PruneExpired(maxAge time.Duration) (int64, error) {
	cutoff := time.Now().Add(-maxAge).UnixNano()
	res, err := s.db.Exec(`DELETE FROM spool_messages WHERE created_at < ?`, cutoff)
	if err != nil {
		return 0, err
	}
	deleted, _ := res.RowsAffected()
	if deleted > 0 {
		log.Printf("[SPOOL] Pruned %d expired spool messages older than %v", deleted, maxAge)
	}
	return deleted, nil
}

func (s *SpoolManager) startPruneLoop(maxAge time.Duration) {
	ticker := time.NewTicker(1 * time.Hour)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			_, _ = s.PruneExpired(maxAge)
		case <-s.stopPrune:
			return
		}
	}
}

func (s *SpoolManager) GetStats() SpoolStats {
	s.mu.Lock()
	defer s.mu.Unlock()

	var sqliteCount int
	row := s.db.QueryRow(`SELECT COUNT(*) FROM spool_messages`)
	_ = row.Scan(&sqliteCount)

	return SpoolStats{
		RAMUsedBytes:    s.ramUsedBytes,
		RAMMaxBytes:     s.ramMaxBytes,
		RAMCount:        len(s.ramQueue),
		SQLiteCount:     sqliteCount,
		DiskMaxBytes:    s.maxDiskBytes,
		DiskMaxMessages: s.maxDiskMessages,
	}
}

func (s *SpoolManager) DB() *sql.DB {
	return s.db
}

func (s *SpoolManager) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	select {
	case <-s.stopPrune:
	default:
		close(s.stopPrune)
	}

	return s.db.Close()
}
