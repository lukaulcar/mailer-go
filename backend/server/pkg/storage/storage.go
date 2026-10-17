package storage

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"mailer-go/backend/shared/crypto"
	"mailer-go/backend/shared/models"
)

type Storage struct {
	baseDir            string
	mailboxesDir       string
	attachmentsDir     string
	maxAttachmentBytes int64
}

func NewStorage(baseDir string) (*Storage, error) {
	if baseDir == "" {
		baseDir = "data/storage"
	}

	mailboxesDir := filepath.Join(baseDir, "mailboxes")
	attachmentsDir := filepath.Join(baseDir, "attachments")

	if err := os.MkdirAll(mailboxesDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create mailboxes storage dir: %w", err)
	}
	if err := os.MkdirAll(attachmentsDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create attachments storage dir: %w", err)
	}

	maxMB := int64(25)
	if val := os.Getenv("MAX_ATTACHMENT_MB"); val != "" {
		if n, err := strconv.ParseInt(val, 10, 64); err == nil && n > 0 {
			maxMB = n
		}
	}

	return &Storage{
		baseDir:            baseDir,
		mailboxesDir:       mailboxesDir,
		attachmentsDir:     attachmentsDir,
		maxAttachmentBytes: maxMB * 1024 * 1024,
	}, nil
}

func sanitizeName(input, fallback string, lowercase, allowAt bool) string {
	clean := strings.TrimSpace(input)
	if lowercase {
		clean = strings.ToLower(clean)
	}
	var b strings.Builder
	for _, r := range clean {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') ||
			r == '.' || r == '-' || r == '_' || (allowAt && r == '@') {
			b.WriteRune(r)
		} else {
			b.WriteRune('_')
		}
	}
	out := b.String()
	for strings.Contains(out, "..") {
		out = strings.ReplaceAll(out, "..", "_")
	}
	out = strings.Trim(out, "._")
	if out == "" {
		return fallback
	}
	if len(out) > 128 {
		out = out[:128]
	}
	return out
}

func sanitizeMailboxName(mailbox string) string {
	return sanitizeName(mailbox, "mailbox", true, true)
}

func sanitizePathSegment(segment string) string {
	return sanitizeName(segment, "file", false, false)
}

func (s *Storage) SaveRawMessage(mailbox, messageID string, raw []byte) (string, error) {
	cleanMb := sanitizeMailboxName(mailbox)
	targetDir := filepath.Join(s.mailboxesDir, cleanMb, "raw")
	if err := os.MkdirAll(targetDir, 0755); err != nil {
		return "", fmt.Errorf("failed to create raw mail directory: %w", err)
	}

	filename := fmt.Sprintf("%s.eml", sanitizePathSegment(messageID))
	fullPath := filepath.Join(targetDir, filename)

	if err := os.WriteFile(fullPath, raw, 0644); err != nil {
		return "", fmt.Errorf("failed to write raw email to disk: %w", err)
	}

	return fullPath, nil
}

func (s *Storage) SaveAttachment(messageID, mailbox, filename, contentType string, data []byte) (*models.Attachment, error) {
	if len(data) == 0 {
		return nil, fmt.Errorf("empty attachment")
	}
	limit := s.maxAttachmentBytes
	if limit <= 0 {
		limit = 25 * 1024 * 1024
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("attachment too large (%d > %d bytes limit)", len(data), limit)
	}
	safeFilename := sanitizePathSegment(filename)
	safeContentType := strings.TrimSpace(contentType)
	if i := strings.Index(safeContentType, ";"); i != -1 {
		safeContentType = strings.TrimSpace(safeContentType[:i])
	}
	if safeContentType == "" {
		safeContentType = "application/octet-stream"
	}
	hash := sha256.Sum256(data)
	hashStr := hex.EncodeToString(hash[:])

	prefix1 := hashStr[:2]
	prefix2 := hashStr[2:4]
	targetDir := filepath.Join(s.attachmentsDir, prefix1, prefix2)

	if err := os.MkdirAll(targetDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create attachment directory: %w", err)
	}

	storagePath := filepath.Join(targetDir, hashStr)

	if _, err := os.Stat(storagePath); os.IsNotExist(err) {
		if err := os.WriteFile(storagePath, data, 0644); err != nil {
			return nil, fmt.Errorf("failed to write attachment to disk: %w", err)
		}
	}

	att := &models.Attachment{
		ID:          crypto.GenerateID("att"),
		MessageID:   messageID,
		Mailbox:     mailbox,
		Filename:    safeFilename,
		ContentType: safeContentType,
		SizeBytes:   int64(len(data)),
		StoragePath: storagePath,
		SHA256:      hashStr,
		CreatedAt:   time.Now().Unix(),
	}

	return att, nil
}

func (s *Storage) isSafePath(storagePath string) bool {
	if storagePath == "" {
		return false
	}
	cleanBase, err := filepath.Abs(s.baseDir)
	if err != nil {
		cleanBase = filepath.Clean(s.baseDir)
	}
	cleanTarget, err := filepath.Abs(storagePath)
	if err != nil {
		cleanTarget = filepath.Clean(storagePath)
	}
	rel, err := filepath.Rel(cleanBase, cleanTarget)
	if err != nil || strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) {
		return false
	}
	return true
}

func (s *Storage) OpenAttachment(storagePath string) (io.ReadCloser, error) {
	if !s.isSafePath(storagePath) {
		return nil, fmt.Errorf("security error: path traversal detected")
	}
	return os.Open(filepath.Clean(storagePath))
}

func (s *Storage) DeleteRawMessage(storagePath string) error {
	if storagePath == "" {
		return nil
	}
	if !s.isSafePath(storagePath) {
		return fmt.Errorf("security error: path traversal detected")
	}
	cleanPath := filepath.Clean(storagePath)
	if err := os.Remove(cleanPath); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}
