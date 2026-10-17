package models

import (
	"strings"
	"time"
)

type MailMessage struct {
	ID           string              `json:"id"`
	From         string              `json:"from"`
	To           []string            `json:"to"`
	Subject      string              `json:"subject"`
	Headers      map[string]string   `json:"headers,omitempty"`
	Body         string              `json:"body"`
	BodyHTML     string              `json:"body_html,omitempty"`
	Raw          string              `json:"raw,omitempty"`
	SizeBytes    int64               `json:"size_bytes"`
	Verification *VerificationResult `json:"verification,omitempty"`
	Attachments  []*Attachment       `json:"attachments,omitempty"`
	CreatedAt    time.Time           `json:"created_at"`
}

type VerificationResult struct {
	IsVerified bool   `json:"is_verified"`
	SPF        string `json:"spf"`
	DKIM       string `json:"dkim"`
	DMARC      string `json:"dmarc"`
	ClientIP   string `json:"client_ip"`
	TLS        bool   `json:"tls"`
	Summary    string `json:"summary"`
}

type DNSRecord struct {
	Type         string `json:"type"`
	Name         string `json:"name"`
	Value        string `json:"value"`
	Priority     int    `json:"priority,omitempty"`
	Purpose      string `json:"purpose"`
	Status       string `json:"status"`
	CurrentValue string `json:"current_value,omitempty"`
	Error        string `json:"error,omitempty"`
}

type DomainDetails struct {
	Domain     string      `json:"domain"`
	Selector   string      `json:"selector"`
	PublicKey  string      `json:"public_key"`
	IsVerified bool        `json:"is_verified"`
	Records    []DNSRecord `json:"records"`
	CreatedAt  int64       `json:"created_at"`
}

type DNSVerificationResult struct {
	Domain         string      `json:"domain"`
	AllVerified    bool        `json:"all_verified"`
	Records        []DNSRecord `json:"records"`
	FailureSummary string      `json:"failure_summary,omitempty"`
}

type EncryptedEnvelope struct {
	Type      string    `json:"type"`
	Payload   string    `json:"payload"`
	Timestamp time.Time `json:"timestamp"`
}

type OutboundSendRequest struct {
	From        string        `json:"from"`
	FromName    string        `json:"from_name,omitempty"`
	To          []string      `json:"to"`
	Subject     string        `json:"subject"`
	Body        string        `json:"body"`
	HTML        string        `json:"html,omitempty"`
	Raw         string        `json:"raw,omitempty"`
	Attachments []*Attachment `json:"attachments,omitempty"`
}

type OutboundSendResponse struct {
	Success       bool              `json:"success"`
	Message       string            `json:"message"`
	MailID        string            `json:"mail_id,omitempty"`
	FailedDomains map[string]string `json:"failed_domains,omitempty"`
}

type Domain struct {
	ID                 string `json:"id"`
	Name               string `json:"name"`
	Selector           string `json:"selector"`
	DKIMPrivateKeyPEM  string `json:"dkim_private_key_pem,omitempty"`
	DKIMPublicKeyB64   string `json:"dkim_public_key_b64"`
	IsActive           bool   `json:"is_active"`
	IsVerified         bool   `json:"is_verified"`
	SPFStatus          string `json:"spf_status"`
	DKIMStatus         string `json:"dkim_status"`
	DMARCStatus        string `json:"dmarc_status"`
	MXStatus           string `json:"mx_status"`
	LastDNSCheckAt     int64  `json:"last_dns_check_at"`
	AssignedMXServerID string `json:"assigned_mx_server_id"`
	CreatedAt          int64  `json:"created_at"`
	UpdatedAt          int64  `json:"updated_at"`
}

type Alias struct {
	ID          string `json:"id"`
	DomainID    string `json:"domain_id"`
	Domain      string `json:"domain"`
	Address     string `json:"address"`
	Destination string `json:"destination"`
	IsActive    bool   `json:"is_active"`
	CreatedAt   int64  `json:"created_at"`
	UpdatedAt   int64  `json:"updated_at"`
}

type ApiKeyScopeType string

const (
	KeyScopeDomain    ApiKeyScopeType = "domain"
	KeyScopeDomains   ApiKeyScopeType = "domains"
	KeyScopeMailbox   ApiKeyScopeType = "mailbox"
	KeyScopeMailboxes ApiKeyScopeType = "mailboxes"
)

type ApiKey struct {
	ID          string          `json:"id"`
	Label       string          `json:"label"`
	Prefix      string          `json:"prefix"`
	ScopeType   ApiKeyScopeType `json:"scope_type"`
	Domains     []string        `json:"domains"`
	Mailbox     string          `json:"mailbox,omitempty"`
	Mailboxes   []string        `json:"mailboxes,omitempty"`
	Permissions []string        `json:"permissions"`
	Scope       *ApiKeyScope    `json:"scope,omitempty"`
	CreatedAt   int64           `json:"created_at"`
	ExpiresAt   *int64          `json:"expires_at,omitempty"`
	Revoked     bool            `json:"revoked"`
}

type ApiKeyScope struct {
	Type      ApiKeyScopeType `json:"type"`
	Domains   []string        `json:"domains"`
	Mailbox   string          `json:"mailbox,omitempty"`
	Mailboxes []string        `json:"mailboxes,omitempty"`
}

func (k *ApiKey) HasPermission(p string) bool {
	if k == nil {
		return false
	}
	for _, perm := range k.Permissions {
		lowerP := strings.ToLower(perm)
		if lowerP == strings.ToLower(p) || lowerP == "full" || lowerP == "all" || lowerP == "*" {
			return true
		}
	}
	return false
}

func (k *ApiKey) CanDeleteMessages() bool {
	return k.HasPermission("delete_messages") || k.HasPermission("delete_mail") || k.HasPermission("delete")
}

func (k *ApiKey) CanDeleteMailbox() bool {
	return k.HasPermission("delete_mailbox") || k.HasPermission("clear_mailbox")
}

func (k *ApiKey) ScopeMailboxes() []string {
	if k == nil {
		return nil
	}
	if k.Scope != nil {
		if len(k.Scope.Mailboxes) > 0 {
			return k.Scope.Mailboxes
		}
		if k.Scope.Mailbox != "" {
			return []string{k.Scope.Mailbox}
		}
	}
	if len(k.Mailboxes) > 0 {
		return k.Mailboxes
	}
	if k.Mailbox != "" {
		return []string{k.Mailbox}
	}
	return nil
}

func (k *ApiKey) Expired(nowUnix int64) bool {
	if k == nil || k.ExpiresAt == nil {
		return false
	}
	return *k.ExpiresAt <= nowUnix
}

func (k *ApiKey) Covers(domain, mailbox string) bool {
	d := strings.ToLower(domain)
	m := strings.ToLower(mailbox)
	switch k.ScopeType {
	case KeyScopeMailbox, KeyScopeMailboxes:
		for _, mb := range k.ScopeMailboxes() {
			if strings.ToLower(mb) == m && m != "" {
				return true
			}
		}
		if m != "" && k.Mailbox != "" {
			return strings.ToLower(k.Mailbox) == m
		}
		if m == "" {
			for _, dd := range k.Domains {
				if strings.ToLower(dd) == d {
					return true
				}
			}
			for _, mb := range k.ScopeMailboxes() {
				if dom := MailboxDomain(mb); dom != "" && dom == d {
					return true
				}
			}
		}
		return false
	default:
		if len(k.Domains) == 0 {
			return true
		}
		for _, dd := range k.Domains {
			if strings.ToLower(dd) == d {
				return true
			}
		}
		return false
	}
}

func MailboxDomain(address string) string {
	address = strings.ToLower(strings.TrimSpace(address))
	parts := strings.SplitN(address, "@", 2)
	if len(parts) != 2 {
		return ""
	}
	return parts[1]
}

type MailTemplate struct {
	ID        string `json:"id"`
	Domain    string `json:"domain"`
	Mailbox   string `json:"mailbox"`
	Name      string `json:"name"`
	Subject   string `json:"subject"`
	HTML      string `json:"html"`
	Text      string `json:"text"`
	UpdatedAt int64  `json:"updated_at"`
}

type TemplateSendRequest struct {
	From        string            `json:"from"`
	FromName    string            `json:"from_name,omitempty"`
	To          []string          `json:"to"`
	Subject     string            `json:"subject,omitempty"`
	Body        string            `json:"body,omitempty"`
	HTML        string            `json:"html,omitempty"`
	Template    string            `json:"template,omitempty"`
	Vars        map[string]string `json:"vars,omitempty"`
	Attachments []*Attachment     `json:"attachments,omitempty"`
}

type SyncDomain struct {
	Domain        string `json:"domain"`
	Selector      string `json:"selector"`
	PrivateKeyPEM string `json:"private_key_pem"`
	PublicKeyB64  string `json:"public_key_b64"`
	IsActive      bool   `json:"is_active"`
	UpdatedAt     int64  `json:"updated_at"`
}

type SyncAlias struct {
	ID          string `json:"id"`
	Domain      string `json:"domain"`
	Address     string `json:"address"`
	Destination string `json:"destination"`
	IsActive    bool   `json:"is_active"`
	UpdatedAt   int64  `json:"updated_at"`
}

type SyncStateResponse struct {
	ServerTime int64        `json:"server_time"`
	Domains    []SyncDomain `json:"domains"`
	Aliases    []SyncAlias  `json:"aliases"`
}

type SyncAction string

const (
	ActionUpsertDomain SyncAction = "UPSERT_DOMAIN"
	ActionDeleteDomain SyncAction = "DELETE_DOMAIN"
	ActionUpsertAlias  SyncAction = "UPSERT_ALIAS"
	ActionDeleteAlias  SyncAction = "DELETE_ALIAS"
	ActionFullSync     SyncAction = "FULL_SYNC"
)

type SyncDeltaMessage struct {
	Action     SyncAction  `json:"action"`
	Domain     *SyncDomain `json:"domain,omitempty"`
	DomainName string      `json:"domain_name,omitempty"`
	Alias      *SyncAlias  `json:"alias,omitempty"`
	AliasID    string      `json:"alias_id,omitempty"`
	Timestamp  int64       `json:"timestamp"`
}

type MailboxKind string

const (
	MailboxKindStandard MailboxKind = "standard"
	MailboxKindSendOnly MailboxKind = "send-only"
	MailboxKindCatchAll MailboxKind = "catch-all"
)

type Mailbox struct {
	ID          string      `json:"id"`
	Address     string      `json:"address"`
	DisplayName string      `json:"display_name"`
	Domain      string      `json:"domain"`
	UsedBytes   int64       `json:"used_bytes"`
	UsedMb      float64     `json:"usedMb"`
	QuotaBytes  int64       `json:"quota_bytes"`
	QuotaMb     float64     `json:"quotaMb"`
	Enabled     bool        `json:"enabled"`
	PasswordSet bool        `json:"passwordSet"`
	Kind        MailboxKind `json:"kind"`
	Plan        int         `json:"plan"`
	CreatedAt   int64       `json:"created_at"`
	UpdatedAt   int64       `json:"updated_at"`
}

const DefaultFreeQuotaBytes = 100 * 1024 * 1024

func (m *Mailbox) EffectiveQuotaBytes(plan int, isLive bool) int64 {
	if m == nil {
		return 0
	}
	if !isLive {
		return 0
	}
	if plan == 1 {
		if m.QuotaBytes < 0 {
			return 0
		}
		return m.QuotaBytes
	}
	return DefaultFreeQuotaBytes
}

type Attachment struct {
	ID          string `json:"id"`
	MessageID   string `json:"message_id"`
	Mailbox     string `json:"mailbox,omitempty"`
	Filename    string `json:"filename"`
	ContentType string `json:"content_type"`
	SizeBytes   int64  `json:"size_bytes"`
	StoragePath string `json:"storage_path,omitempty"`
	SHA256      string `json:"sha256,omitempty"`
	CreatedAt   int64  `json:"created_at"`
	ContentID   string `json:"content_id,omitempty"`
	IsInline    bool   `json:"is_inline,omitempty"`
	Data        []byte `json:"data,omitempty"`
}

type StoredMessage struct {
	ID          string        `json:"id"`
	Mailbox     string        `json:"mailbox"`
	Folder      string        `json:"folder"`
	From        string        `json:"from"`
	To          string        `json:"to"`
	Subject     string        `json:"subject"`
	Body        string        `json:"body"`
	BodyHTML    string        `json:"body_html,omitempty"`
	RawPath     string        `json:"raw_path,omitempty"`
	SizeBytes   int64         `json:"size_bytes"`
	Date        string        `json:"date"`
	Read        bool          `json:"read"`
	Starred     bool          `json:"starred"`
	Attachments []*Attachment `json:"attachments,omitempty"`
	CreatedAt   int64         `json:"created_at"`
}

type LiveEvent struct {
	Type       string      `json:"type"`
	Address    string      `json:"address,omitempty"`
	Folder     string      `json:"folder,omitempty"`
	UsedBytes  int64       `json:"used_bytes,omitempty"`
	UsedMb     float64     `json:"usedMb,omitempty"`
	Message    interface{} `json:"message,omitempty"`
	MessageID  string      `json:"message_id,omitempty"`
	MessageIDs []string    `json:"message_ids,omitempty"`
	Timestamp  int64       `json:"timestamp"`
}

type Subscription struct {
	ID        string   `json:"id"`
	Domain    string   `json:"domain"`
	URL       string   `json:"url"`
	Events    []string `json:"events"`
	Enabled   bool     `json:"enabled"`
	CreatedAt string   `json:"createdAt"`
}
