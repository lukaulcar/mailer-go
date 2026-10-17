package store

import (
	"sync"

	"mailer-go/backend/shared/models"
)

type MailStore struct {
	mu    sync.RWMutex
	mails []*models.MailMessage
}

func NewMailStore() *MailStore {
	return &MailStore{
		mails: make([]*models.MailMessage, 0),
	}
}

const maxStoreMails = 500

func (s *MailStore) Add(mail *models.MailMessage) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.mails = append([]*models.MailMessage{mail}, s.mails...)
	if len(s.mails) > maxStoreMails {
		s.mails = s.mails[:maxStoreMails]
	}
}

func (s *MailStore) GetAll() []*models.MailMessage {
	s.mu.RLock()
	defer s.mu.RUnlock()
	copied := make([]*models.MailMessage, len(s.mails))
	copy(copied, s.mails)
	return copied
}

func (s *MailStore) Remove(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	filtered := make([]*models.MailMessage, 0, len(s.mails))
	for _, m := range s.mails {
		if m.ID != id {
			filtered = append(filtered, m)
		}
	}
	s.mails = filtered
}
