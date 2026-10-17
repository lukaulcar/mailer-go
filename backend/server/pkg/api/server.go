package api

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/mail"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"mailer-go/backend/server/pkg/db"
	"mailer-go/backend/server/pkg/dnschecker"
	"mailer-go/backend/server/pkg/livehub"
	"mailer-go/backend/server/pkg/relayclient"
	"mailer-go/backend/server/pkg/storage"
	"mailer-go/backend/server/pkg/store"
	"mailer-go/backend/server/pkg/syncpusher"
	"mailer-go/backend/server/pkg/usermanager"
	"mailer-go/backend/shared/crypto"
	"mailer-go/backend/shared/httputil"
	"mailer-go/backend/shared/mimeutil"
	"mailer-go/backend/shared/models"
)

type PendingDomain struct {
	Domain    *models.Domain
	UserID    string
	CreatedAt time.Time
}

type APIServer struct {
	store                 *store.MailStore
	client                *relayclient.RelayClient
	db                    *db.DB
	dnsChecker            *dnschecker.DNSChecker
	syncPusher            *syncpusher.SyncPusher
	storage               *storage.Storage
	liveHub               *livehub.LiveHub
	userMgr               *usermanager.UserManager
	selfHosted            bool
	serverHost            string
	mode                  string
	adminEmail            string
	maxUserQuotaGB        int64
	defaultMailboxQuotaMB int64
	authLimiter           *IPRateLimiter
	signupLimiter         *IPRateLimiter
	mu                    sync.RWMutex
	fallbackTokens        map[string]string
	pendingMu             sync.RWMutex
	pendingDomains        map[string]*PendingDomain
}

func NewAPIServer(
	store *store.MailStore,
	client *relayclient.RelayClient,
	database *db.DB,
	dnsChecker *dnschecker.DNSChecker,
	syncPusher *syncpusher.SyncPusher,
	storage *storage.Storage,
	liveHub *livehub.LiveHub,
	userMgr *usermanager.UserManager,
	selfHosted bool,
	serverHost string,
	mode string,
	adminEmail string,
) *APIServer {
	if serverHost == "" || serverHost == "localhost" {
		serverHost = "smtp.lukaulcar.com"
	}
	cleanMode := strings.ToLower(strings.TrimSpace(mode))
	if cleanMode == "" {
		if selfHosted {
			cleanMode = "local"
		} else {
			cleanMode = "live"
		}
	}
	maxUserQuotaGB := int64(50)
	if val := os.Getenv("MAX_USER_QUOTA_GB"); val != "" {
		if n, err := strconv.ParseInt(val, 10, 64); err == nil && n > 0 {
			maxUserQuotaGB = n
		}
	}
	defaultMailboxQuotaMB := int64(100)
	if val := os.Getenv("DEFAULT_MAILBOX_QUOTA_MB"); val != "" {
		if n, err := strconv.ParseInt(val, 10, 64); err == nil && n > 0 {
			defaultMailboxQuotaMB = n
		}
	}
	return &APIServer{
		store:                 store,
		client:                client,
		db:                    database,
		dnsChecker:            dnsChecker,
		syncPusher:            syncPusher,
		storage:               storage,
		liveHub:               liveHub,
		userMgr:               userMgr,
		selfHosted:            selfHosted || cleanMode == "local",
		serverHost:            serverHost,
		mode:                  cleanMode,
		adminEmail:            strings.ToLower(strings.TrimSpace(adminEmail)),
		maxUserQuotaGB:        maxUserQuotaGB,
		defaultMailboxQuotaMB: defaultMailboxQuotaMB,
		authLimiter:           NewIPRateLimiter(10, time.Minute),
		signupLimiter:         NewIPRateLimiter(5, time.Minute),
		fallbackTokens:        make(map[string]string),
		pendingDomains:        make(map[string]*PendingDomain),
	}
}

func (s *APIServer) isLiveMode() bool {
	return strings.ToLower(s.mode) == "live"
}

func (s *APIServer) isAdmin(u *usermanager.User) bool {
	if u == nil {
		return false
	}

	if s.adminEmail != "" && strings.EqualFold(u.Email, s.adminEmail) {
		return true
	}
	return false
}

func (s *APIServer) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/ws/live", s.handleLiveWS)

	mux.HandleFunc("/api/auth/signup", s.handleAuthSignup)
	mux.HandleFunc("/api/auth/login", s.handleAuthLogin)
	mux.HandleFunc("/api/auth/me", s.handleAuthMe)
	mux.HandleFunc("/api/auth/logout", s.handleAuthLogout)
	mux.HandleFunc("/api/user/export", s.handleUserExport)
	mux.HandleFunc("/api/admin/users", s.handleAdminUsers)
	mux.HandleFunc("/api/admin/users/", s.handleAdminUserAction)

	mux.HandleFunc("/api/mailboxes", s.handleMailboxesList)
	mux.HandleFunc("/api/mailboxes/", s.handleMailboxByAddress)
	mux.HandleFunc("/api/mailbox/login", s.handleMailboxLogin)

	mux.HandleFunc("/api/messages", s.handleMessages)
	mux.HandleFunc("/api/messages/", s.handleMessageByID)
	mux.HandleFunc("/api/attachments/", s.handleAttachments)

	mux.HandleFunc("/api/mails", s.handleGetMails)
	mux.HandleFunc("/api/send", s.handleSendMail)
	mux.HandleFunc("/api/status", s.handleStatus)
	mux.HandleFunc("/v1/send", s.handleV1Send)

	mux.HandleFunc("/api/keys", s.handleKeys)
	mux.HandleFunc("/api/keys/", s.handleKeyByID)
	mux.HandleFunc("/api/templates", s.handleTemplates)
	mux.HandleFunc("/api/templates/", s.handleTemplateByID)

	mux.HandleFunc("/api/subscriptions/", s.handleSubscriptionByID)

	mux.HandleFunc("/api/domains", s.handleDomains)
	mux.HandleFunc("/api/domains/", s.handleDomainSubroutes)
	mux.HandleFunc("/api/domains/dns", s.handleDomainsDNS)
	mux.HandleFunc("/api/domains/verify", s.handleDomainsVerify)
	mux.HandleFunc("/api/domains/aliases", s.handleDomainAliases)
}

func (s *APIServer) handleGetMails(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	u := s.resolveUser(r)
	if u == nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	allMails := s.store.GetAll()
	var mails []*models.MailMessage
	if s.isAdmin(u) {
		mails = allMails
	} else {
		for _, m := range allMails {
			allowed := false
			for _, rcpt := range m.To {
				parts := strings.Split(rcpt, "@")
				if len(parts) == 2 && s.ownsDomain(u, parts[1]) {
					allowed = true
					break
				}
			}
			if allowed {
				mails = append(mails, m)
			}
		}
	}
	if mails == nil {
		mails = []*models.MailMessage{}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"total": len(mails),
		"mails": mails,
	})
}

func (s *APIServer) handleSendMail(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	u := s.resolveUser(r)
	if u == nil {
		http.Error(w, "Unauthorized: authentication required to send email", http.StatusUnauthorized)
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, 25<<20)
	var req models.OutboundSendRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request JSON", http.StatusBadRequest)
		return
	}

	rawFrom := strings.TrimSpace(req.From)
	fromAddress := strings.ToLower(rawFrom)
	fromName := strings.TrimSpace(req.FromName)
	if parsed, err := mail.ParseAddress(rawFrom); err == nil {
		fromAddress = strings.ToLower(parsed.Address)
		if fromName == "" && parsed.Name != "" {
			fromName = parsed.Name
		}
	}
	fromDomain := models.MailboxDomain(fromAddress)
	if fromAddress == "" || fromDomain == "" {
		http.Error(w, "'from' must be a valid full email address", http.StatusBadRequest)
		return
	}
	if !s.ownsDomain(u, fromDomain) {
		http.Error(w, fmt.Sprintf("Forbidden: you do not own sending domain %q", fromDomain), http.StatusForbidden)
		return
	}

	if len(req.To) == 0 {
		http.Error(w, "At least one recipient in 'to' is required", http.StatusBadRequest)
		return
	}

	if mb, err := s.lookupMailboxAnywhere(s.db, fromAddress); err == nil && mb != nil {
		if !mb.Enabled {
			http.Error(w, "Mailbox is disabled and cannot send mail. Re-enable it to resume sending.", http.StatusForbidden)
			return
		}
		if fromName == "" {
			fromName = strings.TrimSpace(mb.DisplayName)
		}
	}

	if s.client == nil {
		http.Error(w, "Outbound relay client not initialized", http.StatusInternalServerError)
		return
	}

	req.From = formatFromHeader(fromName, fromAddress)
	req.FromName = fromName

	resp, err := s.client.SendOutboundMail(&req)
	if err != nil {
		log.Printf("[API] relay send failed: %v", err)
		http.Error(w, "Failed to relay outbound email", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

func (s *APIServer) getPendingDomain(name string) *PendingDomain {
	s.pendingMu.RLock()
	defer s.pendingMu.RUnlock()
	return s.pendingDomains[strings.ToLower(strings.TrimSpace(name))]
}

func (s *APIServer) setPendingDomain(name string, pd *PendingDomain) {
	s.pendingMu.Lock()
	defer s.pendingMu.Unlock()
	s.pendingDomains[strings.ToLower(strings.TrimSpace(name))] = pd
}

func (s *APIServer) deletePendingDomain(name string) {
	s.pendingMu.Lock()
	defer s.pendingMu.Unlock()
	delete(s.pendingDomains, strings.ToLower(strings.TrimSpace(name)))
}

func (s *APIServer) resolveAnyDomain(targetDB *db.DB, name string) (*models.Domain, bool) {
	cleanName := strings.ToLower(strings.TrimSpace(name))
	if targetDB != nil {
		if dom, err := targetDB.GetDomain(cleanName); err == nil && dom != nil {
			return dom, false
		}
	}
	if dom, err := s.db.GetDomain(cleanName); err == nil && dom != nil {
		return dom, false
	}
	if pd := s.getPendingDomain(cleanName); pd != nil && pd.Domain != nil {
		return pd.Domain, true
	}
	return nil, false
}

func (s *APIServer) countUserDomains(u *usermanager.User, targetDB *db.DB, excludeDomain string) int {
	exclude := strings.ToLower(strings.TrimSpace(excludeDomain))
	counted := make(map[string]bool)

	if targetDB != nil {
		doms, err := targetDB.ListDomains()
		if err == nil {
			for _, d := range doms {
				dn := strings.ToLower(strings.TrimSpace(d.Name))
				if dn != "" && dn != exclude {
					counted[dn] = true
				}
			}
		}
	}

	if u != nil && s.userMgr != nil {
		if doms, err := s.userMgr.GetDomainsByUserID(u.ID); err == nil {
			for _, dn := range doms {
				dn = strings.ToLower(strings.TrimSpace(dn))
				if dn != "" && dn != exclude {
					counted[dn] = true
				}
			}
		}
	}

	s.pendingMu.RLock()
	for name, pd := range s.pendingDomains {
		dn := strings.ToLower(strings.TrimSpace(name))
		if dn == "" || dn == exclude {
			continue
		}
		if u != nil {
			if pd.UserID == u.ID {
				counted[dn] = true
			}
		} else if s.selfHosted {
			counted[dn] = true
		}
	}
	s.pendingMu.RUnlock()

	return len(counted)
}

func (s *APIServer) verifyDomainLogic(targetDB *db.DB, domainName string, u *usermanager.User) (*models.DNSVerificationResult, *models.Domain, error) {
	cleanDomain := strings.ToLower(strings.TrimSpace(domainName))
	dom, isRAMOnly := s.resolveAnyDomain(targetDB, cleanDomain)
	if dom == nil {
		return nil, nil, fmt.Errorf("domain %q not found", cleanDomain)
	}

	res, err := s.dnsChecker.VerifyDomainDNS(dom.Name, dom.Selector, dom.DKIMPublicKeyB64, s.serverHost)
	if err != nil {
		return nil, dom, err
	}

	verifiedCount := 0
	spfStatus := "pending"
	dkimStatus := "pending"
	dmarcStatus := "pending"
	mxStatus := "pending"

	for _, r := range res.Records {
		if r.Status == "verified" {
			verifiedCount++
		}
		switch {
		case strings.HasPrefix(r.Purpose, "SPF"):
			spfStatus = r.Status
		case strings.HasPrefix(r.Purpose, "DKIM"):
			dkimStatus = r.Status
		case strings.HasPrefix(r.Purpose, "DMARC"):
			dmarcStatus = r.Status
		case strings.HasPrefix(r.Purpose, "MX"):
			mxStatus = r.Status
		}
	}

	dom.SPFStatus = spfStatus
	dom.DKIMStatus = dkimStatus
	dom.DMARCStatus = dmarcStatus
	dom.MXStatus = mxStatus
	dom.LastDNSCheckAt = time.Now().Unix()
	dom.UpdatedAt = time.Now().Unix()

	if !res.AllVerified {
		if dom.IsVerified {
			fails, thresholdReached := s.dnsChecker.RecordFailure(cleanDomain)
			if thresholdReached {
				dom.IsVerified = false
				dom.IsActive = false
				if targetDB != nil {
					_ = targetDB.UpsertDomain(dom)
					_ = targetDB.UpdateDomainDNSStatus(dom.Name, false, spfStatus, dkimStatus, dmarcStatus, mxStatus, dom.LastDNSCheckAt)
					_ = targetDB.SetDomainActive(dom.Name, false)
					if targetDB != s.db {
						_ = s.db.UpsertDomain(dom)
						_ = s.db.UpdateDomainDNSStatus(dom.Name, false, spfStatus, dkimStatus, dmarcStatus, mxStatus, dom.LastDNSCheckAt)
						_ = s.db.SetDomainActive(dom.Name, false)
					}
				}
				if u != nil && s.userMgr != nil {
					_ = s.userMgr.AssociateDomain(cleanDomain, u.ID)
				}
				s.syncPusher.TriggerPush()
				log.Printf("================================================================================\n"+
					"[API DNS ALERT] Domain %s failed %d consecutive checks (threshold %d reached)!\n"+
					"Domain deactivated and removed from MX servers.\n"+
					"Record breakdown:\n%s\n"+
					"================================================================================",
					dom.Name, fails, s.dnsChecker.GetFailThreshold(), res.FailureSummary)
				return res, dom, nil
			} else {
				log.Printf("--------------------------------------------------------------------------------\n"+
					"[API DNS WARNING] Domain %s check flagged failure (attempt %d/%d consecutive failures).\n"+
					"Retaining active status on MX servers.\n"+
					"Record breakdown:\n%s\n"+
					"--------------------------------------------------------------------------------",
					dom.Name, fails, s.dnsChecker.GetFailThreshold(), res.FailureSummary)
				if targetDB != nil {
					_ = targetDB.UpdateDomainDNSStatus(dom.Name, true, spfStatus, dkimStatus, dmarcStatus, mxStatus, dom.LastDNSCheckAt)
					if targetDB != s.db {
						_ = s.db.UpdateDomainDNSStatus(dom.Name, true, spfStatus, dkimStatus, dmarcStatus, mxStatus, dom.LastDNSCheckAt)
					}
				}
				return res, dom, nil
			}
		} else {
			dom.IsVerified = false
			dom.IsActive = false
			if !isRAMOnly && targetDB != nil {
				_ = targetDB.UpdateDomainDNSStatus(dom.Name, false, spfStatus, dkimStatus, dmarcStatus, mxStatus, dom.LastDNSCheckAt)
				_ = targetDB.SetDomainActive(dom.Name, false)
				if targetDB != s.db {
					_ = s.db.UpdateDomainDNSStatus(dom.Name, false, spfStatus, dkimStatus, dmarcStatus, mxStatus, dom.LastDNSCheckAt)
					_ = s.db.SetDomainActive(dom.Name, false)
				}
				s.syncPusher.TriggerPush()
			}
			return res, dom, nil
		}
	}

	if res.AllVerified {
		s.dnsChecker.RecordSuccess(cleanDomain)
		dom.IsVerified = true
		dom.IsActive = true
		if targetDB != nil {
			_ = targetDB.UpsertDomain(dom)
			_ = targetDB.UpdateDomainDNSStatus(dom.Name, true, spfStatus, dkimStatus, dmarcStatus, mxStatus, dom.LastDNSCheckAt)
			_ = targetDB.SetDomainActive(dom.Name, true)
			if targetDB != s.db {
				_ = s.db.UpsertDomain(dom)
				_ = s.db.UpdateDomainDNSStatus(dom.Name, true, spfStatus, dkimStatus, dmarcStatus, mxStatus, dom.LastDNSCheckAt)
				_ = s.db.SetDomainActive(dom.Name, true)
			}
		}
		if u != nil && s.userMgr != nil {
			_ = s.userMgr.AssociateDomain(cleanDomain, u.ID)
		}
		s.deletePendingDomain(cleanDomain)
		s.syncPusher.TriggerPush()
		return res, dom, nil
	}

	return res, dom, nil
}

func (s *APIServer) handleDomains(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	targetDB, _, u := s.resolveDB(r)

	if u == nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	switch r.Method {
	case http.MethodGet:
		domains, err := targetDB.ListDomains()
		if err != nil && targetDB != s.db {
			domains, err = s.db.ListDomains()
		}
		if err != nil {
			http.Error(w, "Failed to fetch domains: "+err.Error(), http.StatusInternalServerError)
			return
		}
		seen := make(map[string]bool)
		var frontList []map[string]interface{}
		for _, d := range domains {
			clean := strings.ToLower(strings.TrimSpace(d.Name))
			if clean == "" || seen[clean] {
				continue
			}
			if !s.isAdmin(u) && !s.ownsDomain(u, clean) {
				continue
			}
			seen[clean] = true
			frontList = append(frontList, s.toFrontDomain(d))
		}

		s.pendingMu.RLock()
		for name, pd := range s.pendingDomains {
			clean := strings.ToLower(strings.TrimSpace(name))
			if clean == "" || seen[clean] {
				continue
			}
			if u != nil && pd.UserID != u.ID && !s.isAdmin(u) {
				continue
			}
			seen[clean] = true
			frontList = append(frontList, s.toFrontDomain(pd.Domain))
		}
		s.pendingMu.RUnlock()

		if frontList == nil {
			frontList = []map[string]interface{}{}
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"domains": frontList,
			"total":   len(frontList),
		})

	case http.MethodPost:
		r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
		var req struct {
			Domain     string `json:"domain"`
			Name       string `json:"name"`
			Selector   string `json:"selector"`
			AssignedMX string `json:"assigned_mx"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid request body", http.StatusBadRequest)
			return
		}

		cleanDomain := strings.ToLower(strings.TrimSpace(req.Domain))
		if cleanDomain == "" {
			cleanDomain = strings.ToLower(strings.TrimSpace(req.Name))
		}
		if cleanDomain == "" || !strings.Contains(cleanDomain, ".") {
			http.Error(w, "valid domain name is required", http.StatusBadRequest)
			return
		}

		if s.userMgr != nil {
			if ownerID, err := s.userMgr.GetUserIDByDomain(cleanDomain); err == nil && ownerID != "" {
				if u != nil && ownerID != u.ID && !s.isAdmin(u) {
					http.Error(w, "This domain is already registered to another account", http.StatusConflict)
					return
				}
			}
		}

		if s.isLiveMode() && u != nil && u.Plan == 0 {
			if s.countUserDomains(u, targetDB, cleanDomain) >= 1 {
				http.Error(w, "Free plan limit reached: maximum 1 domain allowed. Administrator accounts have unlimited domains.", http.StatusForbidden)
				return
			}
		}

		selector := strings.TrimSpace(req.Selector)
		if selector == "" {
			selector = "mail"
		}
		assignedMX := strings.TrimSpace(req.AssignedMX)
		if assignedMX == "" {
			assignedMX = "*"
		}

		existingDom, _ := targetDB.GetDomain(cleanDomain)
		if existingDom == nil && targetDB != s.db {
			existingDom, _ = s.db.GetDomain(cleanDomain)
		}

		var dom *models.Domain
		if existingDom != nil {
			dom = existingDom
		} else {
			pd := s.getPendingDomain(cleanDomain)
			if pd != nil && pd.Domain != nil {
				dom = pd.Domain
			} else {
				privPEM, pubB64, _, err := crypto.GenerateRSAKey(2048)
				if err != nil {
					http.Error(w, "Failed to generate DKIM keypair: "+err.Error(), http.StatusInternalServerError)
					return
				}
				dom = &models.Domain{
					ID:                 "dom_" + cleanDomain,
					Name:               cleanDomain,
					Selector:           selector,
					DKIMPrivateKeyPEM:  privPEM,
					DKIMPublicKeyB64:   pubB64,
					IsActive:           false,
					IsVerified:         false,
					SPFStatus:          "pending",
					DKIMStatus:         "pending",
					DMARCStatus:        "pending",
					MXStatus:           "pending",
					AssignedMXServerID: assignedMX,
					CreatedAt:          time.Now().Unix(),
					UpdatedAt:          time.Now().Unix(),
				}
				uid := ""
				if u != nil {
					uid = u.ID
				}
				s.setPendingDomain(cleanDomain, &PendingDomain{
					Domain:    dom,
					UserID:    uid,
					CreatedAt: time.Now(),
				})
			}
		}

		if targetDB != nil {
			_ = targetDB.UpsertDomain(dom)
			if targetDB != s.db {
				_ = s.db.UpsertDomain(dom)
			}
		}
		if u != nil && s.userMgr != nil {
			_ = s.userMgr.AssociateDomain(cleanDomain, u.ID)
		}

		records := s.dnsChecker.GenerateDNSRecords(dom.Name, dom.Selector, dom.DKIMPublicKeyB64, s.serverHost)

		st := "pending"
		if dom.IsActive && dom.IsVerified {
			st = "verified"
		}
		var dnsList []map[string]string
		for _, r := range records {
			rst := resolveRecordStatus(r, dom)
			dnsList = append(dnsList, map[string]string{
				"kind":   r.Type,
				"host":   r.Name,
				"value":  r.Value,
				"status": rst,
			})
		}
		addedAt := time.Now().Format("2006-01-02")
		if dom.CreatedAt > 0 {
			addedAt = time.Unix(dom.CreatedAt, 0).Format("2006-01-02")
		}
		frontDom := map[string]interface{}{
			"name":      dom.Name,
			"status":    st,
			"addedAt":   addedAt,
			"mxMode":    "default",
			"mxServers": []interface{}{},
			"dns":       dnsList,
			"lastCheck": nil,
		}

		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"success": true,
			"message": "Domain initialized in RAM with 2048-bit DKIM keypair",
			"domain":  frontDom,
			"records": records,
		})

	case http.MethodDelete:
		r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
		domain := r.URL.Query().Get("domain")
		if domain == "" {
			var req struct {
				Domain string `json:"domain"`
			}
			_ = json.NewDecoder(r.Body).Decode(&req)
			domain = req.Domain
		}

		domain = strings.ToLower(strings.TrimSpace(domain))
		if domain == "" {
			http.Error(w, "domain is required", http.StatusBadRequest)
			return
		}

		s.deletePendingDomain(domain)

		if !s.ownsDomain(u, domain) {
			http.Error(w, "Forbidden: you do not own this domain", http.StatusForbidden)
			return
		}

		deletedDom, err := targetDB.DeleteDomain(domain)
		if err != nil && targetDB != s.db {
			deletedDom, err = s.db.DeleteDomain(domain)
		} else if targetDB != s.db {
			_, _ = s.db.DeleteDomain(domain)
		}

		if s.userMgr != nil {
			_ = s.userMgr.DisassociateDomain(domain)
		}

		if deletedDom != nil {
			s.syncPusher.TriggerPush()
		}

		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"success": true,
			"message": "Domain removed successfully",
			"domain":  domain,
		})

	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *APIServer) handleDomainsDNS(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	u := s.resolveUser(r)
	if u == nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	domain := strings.TrimSpace(r.URL.Query().Get("domain"))
	if domain == "" {
		http.Error(w, "domain query parameter is required", http.StatusBadRequest)
		return
	}
	if !s.ownsDomain(u, domain) {
		http.Error(w, "Forbidden: you do not own this domain", http.StatusForbidden)
		return
	}

	targetDB, _, _ := s.resolveDB(r)
	dom, _ := s.resolveAnyDomain(targetDB, domain)
	if dom == nil {
		http.Error(w, "domain not found", http.StatusNotFound)
		return
	}

	records := s.dnsChecker.GenerateDNSRecords(dom.Name, dom.Selector, dom.DKIMPublicKeyB64, s.serverHost)

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"domain":      dom.Name,
		"selector":    dom.Selector,
		"public_key":  dom.DKIMPublicKeyB64,
		"is_verified": dom.IsVerified,
		"records":     records,
	})
}

func (s *APIServer) handleDomainsVerify(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	domain := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("domain")))
	if domain == "" {
		var req struct {
			Domain string `json:"domain"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		domain = strings.ToLower(strings.TrimSpace(req.Domain))
	}

	if domain == "" {
		http.Error(w, "domain is required", http.StatusBadRequest)
		return
	}

	targetDB, _, u := s.resolveDB(r)
	if u == nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	if !s.ownsDomain(u, domain) {
		http.Error(w, "Forbidden: you do not own this domain", http.StatusForbidden)
		return
	}

	allowed, retryAfter := s.dnsChecker.CheckRateLimit(domain)
	if !allowed {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Retry-After", fmt.Sprintf("%d", retryAfter))
		w.WriteHeader(http.StatusTooManyRequests)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"error":            "Rate limit exceeded: only 1 DNS check per 30 seconds allowed per domain",
			"retry_after_secs": retryAfter,
			"rate_limited":     true,
		})
		return
	}

	result, updatedDom, err := s.verifyDomainLogic(targetDB, domain, u)
	if err != nil {
		http.Error(w, "DNS check failed: "+err.Error(), http.StatusInternalServerError)
		return
	}

	type DnsRec struct {
		Kind         string `json:"kind"`
		Host         string `json:"host"`
		Value        string `json:"value"`
		Status       string `json:"status"`
		Error        string `json:"error,omitempty"`
		CurrentValue string `json:"current_value,omitempty"`
	}
	var dnsList []DnsRec
	for _, rec := range result.Records {
		st := "fail"
		if rec.Status == "verified" {
			st = "ok"
		}
		dnsList = append(dnsList, DnsRec{
			Kind:         rec.Type,
			Host:         rec.Name,
			Value:        rec.Value,
			Status:       st,
			Error:        rec.Error,
			CurrentValue: rec.CurrentValue,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"domain":          updatedDom.Name,
		"all_verified":    result.AllVerified,
		"records":         result.Records,
		"dns":             dnsList,
		"is_active":       updatedDom.IsActive,
		"failure_summary": result.FailureSummary,
	})
}

func (s *APIServer) handleDomainAliases(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	u := s.resolveUser(r)
	if u == nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	switch r.Method {
	case http.MethodGet:
		domain := strings.TrimSpace(r.URL.Query().Get("domain"))
		if domain == "" {
			http.Error(w, "domain query parameter is required", http.StatusBadRequest)
			return
		}
		if !s.ownsDomain(u, domain) {
			http.Error(w, "Forbidden: you do not own this domain", http.StatusForbidden)
			return
		}

		aliases, err := s.db.ListAliasesByDomain(domain)
		if err != nil {
			http.Error(w, "Failed to list aliases: "+err.Error(), http.StatusInternalServerError)
			return
		}

		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"domain":  domain,
			"aliases": aliases,
			"total":   len(aliases),
		})

	case http.MethodPost:
		var req struct {
			Domain      string `json:"domain"`
			Address     string `json:"address"`
			Destination string `json:"destination"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "Invalid JSON body", http.StatusBadRequest)
			return
		}

		if strings.TrimSpace(req.Domain) == "" || strings.TrimSpace(req.Address) == "" {
			http.Error(w, "domain and address are required", http.StatusBadRequest)
			return
		}
		if !s.ownsDomain(u, req.Domain) {
			http.Error(w, "Forbidden: you do not own this domain", http.StatusForbidden)
			return
		}

		dest := strings.TrimSpace(req.Destination)
		if dest == "" {
			dest = "inbox"
		}

		alias, err := s.db.CreateAlias(req.Domain, req.Address, dest)
		if err != nil {
			http.Error(w, "Failed to create alias: "+err.Error(), http.StatusBadRequest)
			return
		}

		s.syncPusher.TriggerPush()

		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"success": true,
			"alias":   alias,
			"message": "Alias created successfully and synced to MX workers",
		})

	case http.MethodDelete:
		r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
		id := strings.TrimSpace(r.URL.Query().Get("id"))
		if id == "" {
			var req struct {
				ID string `json:"id"`
			}
			_ = json.NewDecoder(r.Body).Decode(&req)
			id = strings.TrimSpace(req.ID)
		}

		if id == "" {
			http.Error(w, "id parameter is required", http.StatusBadRequest)
			return
		}

		if existing, err := s.db.GetAliasByID(id); err == nil && existing != nil {
			if !s.ownsDomain(u, existing.Domain) {
				http.Error(w, "Forbidden: you do not own this domain", http.StatusForbidden)
				return
			}
		} else if !s.isAdmin(u) {

			if targetDB, _, _ := s.resolveDB(r); targetDB != nil {
				if existing2, err2 := targetDB.GetAliasByID(id); err2 == nil && existing2 != nil {
					if !s.ownsDomain(u, existing2.Domain) {
						http.Error(w, "Forbidden: you do not own this domain", http.StatusForbidden)
						return
					}
				}
			}
		}

		deletedAlias, err := s.db.DeleteAlias(id)
		if err != nil {
			http.Error(w, "Failed to delete alias: "+err.Error(), http.StatusInternalServerError)
			return
		}

		s.syncPusher.TriggerPush()

		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"success": true,
			"deleted": deletedAlias,
			"message": "Alias deleted successfully",
		})

	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *APIServer) handleStatus(w http.ResponseWriter, r *http.Request) {
	if s.resolveUser(r) == nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	status := map[string]interface{}{
		"service": "central-control-plane-backend",
		"ok":      true,
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(status)
}

func bearerKey(r *http.Request) string {
	h := strings.TrimSpace(r.Header.Get("Authorization"))
	if strings.HasPrefix(strings.ToLower(h), "bearer ") {
		return strings.TrimSpace(h[7:])
	}
	if k := strings.TrimSpace(r.Header.Get("X-API-Key")); k != "" {
		return k
	}
	if k := strings.TrimSpace(r.Header.Get("X-Api-Key")); k != "" {
		return k
	}
	if k := strings.TrimSpace(r.URL.Query().Get("api_key")); k != "" {
		return k
	}

	return ""
}

func (s *APIServer) authenticateApiKeyAnywhere(raw string) *models.ApiKey {
	clean := strings.TrimSpace(raw)
	if clean == "" {
		return nil
	}
	if s.db != nil {
		if k, err := s.db.AuthenticateApiKey(clean); err == nil && k != nil {
			return k
		}
	}
	return nil
}

func (s *APIServer) resolveApiKey(r *http.Request) *models.ApiKey {
	keyStr := bearerKey(r)
	if keyStr != "" {
		return s.authenticateApiKeyAnywhere(keyStr)
	}
	return nil
}

func (s *APIServer) ownsDomain(u *usermanager.User, domain string) bool {
	if u == nil {
		return false
	}
	if s.isAdmin(u) {
		return true
	}
	clean := strings.ToLower(strings.TrimSpace(domain))
	if clean == "" {
		return false
	}
	if s.userMgr != nil {
		ownerID, err := s.userMgr.GetUserIDByDomain(clean)
		if err == nil && ownerID == u.ID {
			return true
		}
	}
	s.pendingMu.RLock()
	if pd, ok := s.pendingDomains[clean]; ok && pd != nil {
		if pd.UserID == u.ID {
			s.pendingMu.RUnlock()
			return true
		}
	}
	s.pendingMu.RUnlock()
	return false
}

func validateWebhookURL(raw string) error {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return fmt.Errorf("url is required")
	}
	if len(raw) > 2048 {
		return fmt.Errorf("url too long")
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("invalid url")
	}
	if parsed.Scheme != "https" && parsed.Scheme != "http" {
		return fmt.Errorf("url must use https (http allowed only for testing)")
	}
	if parsed.User != nil {
		return fmt.Errorf("url must not contain credentials")
	}
	host := strings.ToLower(strings.TrimSpace(parsed.Hostname()))
	if host == "" || host == "localhost" || strings.HasSuffix(host, ".localhost") ||
		strings.HasSuffix(host, ".local") || strings.HasSuffix(host, ".internal") ||
		strings.HasSuffix(host, ".invalid") || strings.HasSuffix(host, ".test") ||
		strings.HasSuffix(host, ".example") {
		return fmt.Errorf("webhook host not allowed")
	}
	if ip := net.ParseIP(strings.Trim(host, "[]")); ip != nil {
		return fmt.Errorf("webhook host must be a public DNS name, not an IP literal")
	}
	if ips, err := net.LookupIP(host); err == nil {
		for _, ip := range ips {
			if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() ||
				ip.IsLinkLocalUnicast() || ip.IsMulticast() || ip.IsUnspecified() {
				return fmt.Errorf("webhook host resolves to a non-public address")
			}
		}
	}
	return nil
}

func firstNonEmpty(vals ...*string) string {
	for _, v := range vals {
		if v != nil && strings.TrimSpace(*v) != "" {
			return strings.TrimSpace(*v)
		}
	}
	return ""
}

func toFrontKey(k *models.ApiKey) map[string]interface{} {
	var exp *string
	if k.ExpiresAt != nil && *k.ExpiresAt > 0 {
		s := time.Unix(*k.ExpiresAt, 0).Format("2006-01-02")
		exp = &s
	}
	created := time.Now().Format("2006-01-02")
	if k.CreatedAt > 0 {
		created = time.Unix(k.CreatedAt, 0).Format("2006-01-02")
	}
	perms := k.Permissions
	if len(perms) == 0 {
		perms = []string{"send"}
	}
	return map[string]interface{}{
		"id":          k.ID,
		"label":       k.Label,
		"prefix":      k.Prefix,
		"createdAt":   created,
		"scope":       k.Scope,
		"permissions": perms,
		"expiresAt":   exp,
	}
}

func (s *APIServer) handleKeys(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	targetDB, _, u := s.resolveDB(r)
	if u == nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	switch r.Method {
	case http.MethodGet:
		filterDomain := strings.TrimSpace(r.URL.Query().Get("domain"))
		if filterDomain != "" && !s.ownsDomain(u, filterDomain) {
			http.Error(w, "Forbidden: you do not own this domain", http.StatusForbidden)
			return
		}
		keys, err := s.db.ListApiKeys(filterDomain)
		if err != nil && targetDB != nil {
			keys, err = targetDB.ListApiKeys(filterDomain)
		} else if targetDB != nil && targetDB != s.db {
			if ukeys, uerr := targetDB.ListApiKeys(filterDomain); uerr == nil && len(ukeys) > 0 {
				seen := make(map[string]bool)
				for _, k := range keys {
					seen[k.ID] = true
				}
				for _, uk := range ukeys {
					if !seen[uk.ID] {
						keys = append(keys, uk)
					}
				}
			}
		}
		if err != nil {
			http.Error(w, "Failed to list keys: "+err.Error(), http.StatusInternalServerError)
			return
		}
		var frontKeys []map[string]interface{}
		for _, k := range keys {
			if !s.isAdmin(u) {
				allowed := false
				for _, d := range k.Domains {
					if s.ownsDomain(u, d) {
						allowed = true
						break
					}
				}
				if !allowed && k.Mailbox != "" && s.ownsDomain(u, models.MailboxDomain(k.Mailbox)) {
					allowed = true
				}
				for _, mb := range k.Mailboxes {
					if s.ownsDomain(u, models.MailboxDomain(mb)) {
						allowed = true
						break
					}
				}
				if !allowed {
					continue
				}
			}
			frontKeys = append(frontKeys, toFrontKey(k))
		}
		if frontKeys == nil {
			frontKeys = []map[string]interface{}{}
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"keys": frontKeys})
	case http.MethodPost:
		r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
		var req struct {
			Label       string              `json:"label"`
			Scope       *models.ApiKeyScope `json:"scope"`
			Permissions []string            `json:"permissions"`
			ExpiresAt   *string             `json:"expiresAt"`
			ExpiresOn   *string             `json:"expires_on"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "Invalid JSON body", http.StatusBadRequest)
			return
		}
		scopeType := models.KeyScopeDomain
		var domains []string
		var mailbox string
		var mailboxes []string
		if req.Scope != nil {
			scopeType = req.Scope.Type
			domains = req.Scope.Domains
			mailbox = req.Scope.Mailbox
			mailboxes = req.Scope.Mailboxes
		}
		if !s.isAdmin(u) {
			if (scopeType == models.KeyScopeDomain || scopeType == models.KeyScopeDomains) && len(domains) == 0 {
				http.Error(w, "Forbidden: picking at least one owned domain is required", http.StatusForbidden)
				return
			}
			for _, d := range domains {
				if !s.ownsDomain(u, d) {
					http.Error(w, fmt.Sprintf("Forbidden: you do not own domain %q", d), http.StatusForbidden)
					return
				}
			}
			if mailbox != "" && !s.ownsDomain(u, models.MailboxDomain(mailbox)) {
				http.Error(w, fmt.Sprintf("Forbidden: you do not own mailbox %q", mailbox), http.StatusForbidden)
				return
			}
			for _, mb := range mailboxes {
				if !s.ownsDomain(u, models.MailboxDomain(mb)) {
					http.Error(w, fmt.Sprintf("Forbidden: you do not own mailbox %q", mb), http.StatusForbidden)
					return
				}
			}
		}
		var expiresPtr *int64
		if expStr := strings.TrimSpace(firstNonEmpty(req.ExpiresAt, req.ExpiresOn)); expStr != "" {
			var ts int64
			if t, err := time.Parse("2006-01-02", expStr); err == nil {
				ts = t.Add(24*time.Hour - time.Second).Unix()
			} else if t, err := time.Parse(time.RFC3339, expStr); err == nil {
				ts = t.Unix()
			} else if n, err := strconv.ParseInt(expStr, 10, 64); err == nil {
				ts = n
				if ts >= 1e12 {
					ts = ts / 1000
				}
			} else {
				http.Error(w, "expiresAt must be YYYY-MM-DD", http.StatusBadRequest)
				return
			}
			if ts <= time.Now().Unix() {
				http.Error(w, "expiry must be in the future", http.StatusBadRequest)
				return
			}
			expiresPtr = &ts
		}
		key, secret, err := s.db.CreateApiKey(req.Label, scopeType, domains, mailbox, mailboxes, req.Permissions, expiresPtr)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"key": toFrontKey(key), "secret": secret})
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *APIServer) handleKeyByID(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	u := s.resolveUser(r)
	if u == nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	id := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/keys/"), "/")
	if id == "" {
		http.Error(w, "key id is required", http.StatusBadRequest)
		return
	}
	targetDB, _, _ := s.resolveDB(r)
	key, err := targetDB.GetApiKeyByID(id)
	if err != nil && targetDB != s.db {
		key, err = s.db.GetApiKeyByID(id)
	}
	if err != nil || key == nil {
		http.Error(w, "Key not found", http.StatusNotFound)
		return
	}
	if !s.isAdmin(u) {
		allowed := false
		for _, d := range key.Domains {
			if s.ownsDomain(u, d) {
				allowed = true
				break
			}
		}
		if !allowed && key.Mailbox != "" && s.ownsDomain(u, models.MailboxDomain(key.Mailbox)) {
			allowed = true
		}
		for _, mb := range key.Mailboxes {
			if s.ownsDomain(u, models.MailboxDomain(mb)) {
				allowed = true
				break
			}
		}
		if !allowed {
			http.Error(w, "Forbidden: you do not own the domain associated with this API key", http.StatusForbidden)
			return
		}
	}
	if err := s.db.RevokeApiKey(id); err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{"success": true})
}

func (s *APIServer) handleTemplates(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	targetDB, _, u := s.resolveDB(r)

	mailbox := strings.TrimSpace(r.URL.Query().Get("mailbox"))
	domain := strings.TrimSpace(r.URL.Query().Get("domain"))

	switch r.Method {
	case http.MethodGet:
		if mailbox != "" {
			if !s.isMailboxAuthorized(r, mailbox) {
				http.Error(w, "Unauthorized", http.StatusUnauthorized)
				return
			}
		} else if domain != "" {
			if u == nil {
				http.Error(w, "Unauthorized", http.StatusUnauthorized)
				return
			}
			if !s.ownsDomain(u, domain) {
				http.Error(w, "Forbidden: you do not own this domain", http.StatusForbidden)
				return
			}
		} else {
			http.Error(w, "mailbox or domain query parameter is required", http.StatusBadRequest)
			return
		}

		var list []*models.MailTemplate
		var err error
		if mailbox != "" {
			list, err = targetDB.ListTemplatesByMailbox(mailbox)
		} else if domain != "" {
			list, err = targetDB.ListTemplatesByDomain(domain)
		}
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if list == nil {
			list = []*models.MailTemplate{}
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"templates": list})
	case http.MethodPost:
		r.Body = http.MaxBytesReader(w, r.Body, 5<<20)
		var req struct {
			Domain  string `json:"domain"`
			Mailbox string `json:"mailbox"`
			Name    string `json:"name"`
			Subject string `json:"subject"`
			HTML    string `json:"html"`
			Text    string `json:"text"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "Invalid JSON body", http.StatusBadRequest)
			return
		}
		if req.Domain == "" {
			req.Domain = models.MailboxDomain(req.Mailbox)
		}

		if req.Mailbox != "" && !s.isMailboxAuthorized(r, req.Mailbox) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		if req.Mailbox == "" {
			if u == nil {
				http.Error(w, "Unauthorized", http.StatusUnauthorized)
				return
			}
			if !s.ownsDomain(u, req.Domain) {
				http.Error(w, "Forbidden: you do not own this domain", http.StatusForbidden)
				return
			}
		}

		tpl, err := targetDB.UpsertTemplate(req.Domain, req.Mailbox, req.Name, req.Subject, req.HTML, req.Text)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"template": tpl})
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *APIServer) handleTemplateByID(w http.ResponseWriter, r *http.Request) {
	id := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/templates/"), "/")
	if id == "" {
		http.Error(w, "Template ID required", http.StatusBadRequest)
		return
	}
	targetDB, _, u := s.resolveDB(r)
	w.Header().Set("Content-Type", "application/json")

	tpl, err := targetDB.GetTemplateByID(id)
	if err != nil && targetDB != s.db {
		tpl, err = s.db.GetTemplateByID(id)
	}
	if err != nil || tpl == nil {
		http.Error(w, "Template not found", http.StatusNotFound)
		return
	}

	if tpl.Mailbox != "" && !s.isMailboxAuthorized(r, tpl.Mailbox) {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	if tpl.Mailbox == "" {
		if u == nil {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		if !s.ownsDomain(u, tpl.Domain) {
			http.Error(w, "Forbidden: you do not own this domain", http.StatusForbidden)
			return
		}
	}

	switch r.Method {
	case http.MethodPatch:
		r.Body = http.MaxBytesReader(w, r.Body, 5<<20)
		var req struct {
			Name    string `json:"name"`
			Subject string `json:"subject"`
			HTML    string `json:"html"`
			Text    string `json:"text"`
			Mailbox string `json:"mailbox"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "Invalid JSON body", http.StatusBadRequest)
			return
		}
		updated, err := targetDB.UpdateTemplate(id, req.Name, req.Subject, req.HTML, req.Text, req.Mailbox)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if targetDB != s.db {
			_, _ = s.db.UpdateTemplate(id, req.Name, req.Subject, req.HTML, req.Text, req.Mailbox)
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"template": updated})
	case http.MethodDelete:
		if err := targetDB.DeleteTemplate(id); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"success": true})
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *APIServer) handleSubscriptionByID(w http.ResponseWriter, r *http.Request) {
	id := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/subscriptions/"), "/")
	if id == "" {
		http.Error(w, "Subscription ID required", http.StatusBadRequest)
		return
	}
	targetDB, _, u := s.resolveDB(r)
	if u == nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	w.Header().Set("Content-Type", "application/json")

	authorizeSubscription := func() (*models.Subscription, bool) {
		sub, err := targetDB.GetSubscriptionByID(id)
		if err != nil && targetDB != s.db {
			sub, err = s.db.GetSubscriptionByID(id)
		}
		if err != nil || sub == nil {
			http.Error(w, "Subscription not found", http.StatusNotFound)
			return nil, false
		}
		if !s.ownsDomain(u, sub.Domain) {
			http.Error(w, "Forbidden: you do not own this domain", http.StatusForbidden)
			return nil, false
		}
		return sub, true
	}
	if _, ok := authorizeSubscription(); !ok {
		return
	}

	switch r.Method {
	case http.MethodPatch:
		r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
		var req struct {
			Enabled bool `json:"enabled"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "Invalid JSON body", http.StatusBadRequest)
			return
		}
		sub, err := targetDB.UpdateSubscriptionEnabled(id, req.Enabled)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"subscription": sub})
	case http.MethodDelete:
		if err := targetDB.DeleteSubscription(id); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"success": true})
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func renderVars(src string, vars map[string]string) string {
	out := src
	for k, v := range vars {
		out = strings.ReplaceAll(out, "{{"+k+"}}", v)
		out = strings.ReplaceAll(out, "{{ "+k+" }}", v)
		out = strings.ReplaceAll(out, "{{  "+k+"  }}", v)
	}
	return out
}

func (s *APIServer) handleV1Send(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	key, err := s.db.AuthenticateApiKey(bearerKey(r))
	if err != nil {
		http.Error(w, "Unauthorized: valid API key required (create one in Settings → API keys)", http.StatusUnauthorized)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 25<<20)
	var req models.TemplateSendRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request JSON", http.StatusBadRequest)
		return
	}
	rawFrom := strings.TrimSpace(req.From)
	fromAddress := strings.ToLower(rawFrom)
	fromName := strings.TrimSpace(req.FromName)
	if parsed, err := mail.ParseAddress(rawFrom); err == nil {
		fromAddress = strings.ToLower(parsed.Address)
		if fromName == "" && parsed.Name != "" {
			fromName = parsed.Name
		}
	}
	domain := models.MailboxDomain(fromAddress)
	if fromAddress == "" || domain == "" {
		http.Error(w, "`from` must be a full mailbox address", http.StatusBadRequest)
		return
	}
	if !key.Covers(domain, fromAddress) {
		http.Error(w, fmt.Sprintf("API key %q (%s) may not send as %s", key.Label, key.Prefix, fromAddress), http.StatusForbidden)
		return
	}
	if mb, err := s.lookupMailboxAnywhere(s.db, fromAddress); err == nil && mb != nil {
		if !mb.Enabled {
			http.Error(w, "Mailbox is disabled and cannot send mail. Re-enable it to resume sending.", http.StatusForbidden)
			return
		}
		if fromName == "" {
			fromName = strings.TrimSpace(mb.DisplayName)
		}
	}
	subject := req.Subject
	body := req.Body
	html := req.HTML
	if strings.TrimSpace(req.Template) != "" {
		tpl, err := s.db.GetTemplate(fromAddress, req.Template)
		if err != nil {
			http.Error(w, "Unknown template "+req.Template+" for "+fromAddress, http.StatusNotFound)
			return
		}
		vars := req.Vars
		if vars == nil {
			vars = map[string]string{}
		}
		subject = renderVars(tpl.Subject, vars)
		html = renderVars(tpl.HTML, vars)
		body = renderVars(tpl.Text, vars)
	}
	if len(req.To) == 0 {
		http.Error(w, "`to` is required", http.StatusBadRequest)
		return
	}
	if s.client == nil {
		http.Error(w, "Outbound relay client not initialized", http.StatusInternalServerError)
		return
	}
	fromHeader := formatFromHeader(fromName, fromAddress)
	rawEML := buildMIMEMessage(fromHeader, req.To, subject, body, html, req.Attachments)
	if rawEML == "" {
		http.Error(w, "Invalid from/to/subject headers", http.StatusBadRequest)
		return
	}
	resp, err := s.client.SendOutboundMail(&models.OutboundSendRequest{
		From:        fromHeader,
		FromName:    fromName,
		To:          req.To,
		Subject:     subject,
		Body:        body,
		HTML:        html,
		Raw:         rawEML,
		Attachments: req.Attachments,
	})
	if err != nil {
		log.Printf("[API] relay send failed: %v", err)
		http.Error(w, "Failed to relay outbound email", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

func (s *APIServer) handleMailboxesList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	targetDB, _, u := s.resolveDB(r)
	if u == nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	mailboxes, err := targetDB.ListAllMailboxes()
	if err != nil {
		http.Error(w, "Failed to list mailboxes: "+err.Error(), http.StatusInternalServerError)
		return
	}
	if mailboxes == nil {
		mailboxes = []*models.Mailbox{}
	}
	plan := 0
	if u != nil {
		plan = u.Plan
	}
	for _, m := range mailboxes {
		m.Plan = plan
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"mailboxes": mailboxes,
		"total":     len(mailboxes),
	})
}

func (s *APIServer) handleMailboxLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	ip := httputil.ClientIP(r)
	if !s.authLimiter.Allow(ip) {
		http.Error(w, "Too many login attempts. Please wait a minute.", http.StatusTooManyRequests)
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	var req struct {
		Address  string `json:"address"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON body", http.StatusBadRequest)
		return
	}

	targetDB, _, user := s.resolveDBForAddress(r, req.Address)
	mb, err := targetDB.AuthenticateMailbox(req.Address, req.Password)
	if err != nil {
		if targetDB != s.db {
			mb, err = s.db.AuthenticateMailbox(req.Address, req.Password)
		}
		if err != nil {
			http.Error(w, err.Error(), http.StatusUnauthorized)
			return
		}
	}
	if user != nil {
		mb.Plan = user.Plan
	}

	token, err := s.createMailboxToken(mb.Address)
	if err != nil {
		http.Error(w, "Failed to create mailbox session: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"mailbox": mb,
		"token":   token,
	})
}

func (s *APIServer) handleMailboxByAddress(w http.ResponseWriter, r *http.Request) {
	subPath := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/mailboxes/"), "/")
	if subPath == "" {
		s.handleMailboxesList(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	targetDB, targetStorage, user := s.resolveDBForAddress(r, subPath)

	if strings.HasSuffix(subPath, "/templates") {
		address := strings.TrimSuffix(subPath, "/templates")
		if !s.isMailboxAuthorized(r, address) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		switch r.Method {
		case http.MethodGet:
			list, err := targetDB.ListTemplatesByMailbox(address)
			if err != nil {
				http.Error(w, "Failed to list templates: "+err.Error(), http.StatusInternalServerError)
				return
			}
			if list == nil {
				list = []*models.MailTemplate{}
			}
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"templates": list})
		case http.MethodPost:
			r.Body = http.MaxBytesReader(w, r.Body, 5<<20)
			var req struct {
				Name    string `json:"name"`
				Subject string `json:"subject"`
				HTML    string `json:"html"`
				Text    string `json:"text"`
			}
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				http.Error(w, "Invalid JSON body", http.StatusBadRequest)
				return
			}
			dom := models.MailboxDomain(address)
			tpl, err := targetDB.UpsertTemplate(dom, address, req.Name, req.Subject, req.HTML, req.Text)
			if err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"template": tpl})
		default:
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
		return
	}

	if strings.HasSuffix(subPath, "/password") {
		if r.Method != http.MethodPatch {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		address := strings.TrimSuffix(subPath, "/password")
		if !s.isMailboxAuthorized(r, address) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
		var req struct {
			Password string `json:"password"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || len(req.Password) < 8 {
			http.Error(w, "Password must be at least 8 characters", http.StatusBadRequest)
			return
		}
		if err := targetDB.UpdateMailboxPassword(address, req.Password); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"success": true})
		return
	}

	if strings.HasSuffix(subPath, "/messages") ||
		strings.HasSuffix(subPath, "/messages/clear") ||
		strings.HasSuffix(subPath, "/messages/delete") {
		var address string
		isClearRoute := false
		isDeleteRoute := false
		if strings.HasSuffix(subPath, "/messages/clear") {
			address = strings.TrimSuffix(subPath, "/messages/clear")
			isClearRoute = true
		} else if strings.HasSuffix(subPath, "/messages/delete") {
			address = strings.TrimSuffix(subPath, "/messages/delete")
			isDeleteRoute = true
		} else {
			address = strings.TrimSuffix(subPath, "/messages")
		}

		if !s.isMailboxAuthorized(r, address) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}

		switch r.Method {
		case http.MethodGet:
			if isClearRoute || isDeleteRoute {
				http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
				return
			}
			folder := r.URL.Query().Get("folder")
			if folder == "" {
				folder = "inbox"
			}
			messages, err := targetDB.ListMessages(address, folder)
			if err != nil {
				http.Error(w, "Failed to list messages: "+err.Error(), http.StatusInternalServerError)
				return
			}
			if messages == nil {
				messages = []*models.StoredMessage{}
			}
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"messages": messages,
				"total":    len(messages),
			})
			return

		case http.MethodDelete, http.MethodPost:
			var req struct {
				IDs    []string `json:"ids"`
				Folder string   `json:"folder"`
				All    bool     `json:"all"`
			}
			if r.Body != nil {
				_ = json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req)
			}

			if len(req.IDs) == 0 && !isClearRoute {
				if idsParam := strings.TrimSpace(r.URL.Query().Get("ids")); idsParam != "" {
					parts := strings.Split(idsParam, ",")
					for _, p := range parts {
						if cleanID := strings.TrimSpace(p); cleanID != "" {
							req.IDs = append(req.IDs, cleanID)
						}
					}
				}
			}

			folder := strings.ToLower(strings.TrimSpace(req.Folder))
			if folder == "" {
				folder = strings.ToLower(strings.TrimSpace(r.URL.Query().Get("folder")))
			}
			if folder == "" {
				folder = "inbox"
			}

			all := req.All || r.URL.Query().Get("all") == "true" || folder == "all" || folder == "*"
			if all {
				folder = "all"
			}

			if r.Method == http.MethodPost && !isClearRoute && len(req.IDs) == 0 && !req.All && folder != "all" && folder != "*" {
				http.Error(w, "Invalid request: specify 'ids' to delete, or use /clear to clear folder", http.StatusBadRequest)
				return
			}

			apiKey := s.resolveApiKey(r)
			if len(req.IDs) > 0 && !isClearRoute {
				if apiKey != nil && !apiKey.CanDeleteMessages() {
					http.Error(w, "Forbidden: API key does not have permission to delete messages", http.StatusForbidden)
					return
				}
			} else {
				if apiKey != nil && !apiKey.CanDeleteMailbox() {
					http.Error(w, "Forbidden: API key does not have permission to clear/delete mailbox", http.StatusForbidden)
					return
				}
			}

			var deleted []*models.StoredMessage
			var err error

			if len(req.IDs) > 0 && !isClearRoute {
				deleted, err = targetDB.DeleteMailboxMessagesByIDs(address, req.IDs)
				if err == nil && targetDB != s.db {
					_, _ = s.db.DeleteMailboxMessagesByIDs(address, req.IDs)
				}
			} else {
				deleted, err = targetDB.ClearMessages(address, folder)
				if err == nil && targetDB != s.db {
					_, _ = s.db.ClearMessages(address, folder)
				}
			}

			if err != nil {
				http.Error(w, "Failed to delete messages: "+err.Error(), http.StatusInternalServerError)
				return
			}

			var freedBytes int64
			deletedIDs := make([]string, 0, len(deleted))
			for _, m := range deleted {
				deletedIDs = append(deletedIDs, m.ID)
				freedBytes += m.SizeBytes
				if m.RawPath != "" {
					if err := targetStorage.DeleteRawMessage(m.RawPath); err != nil && targetStorage != s.storage {
						_ = s.storage.DeleteRawMessage(m.RawPath)
					}
				}
				if s.store != nil {
					s.store.Remove(m.ID)
				}
			}

			if updatedMb, err := targetDB.GetMailbox(address); err == nil && updatedMb != nil {
				s.liveHub.NotifyMailboxUsage(address, updatedMb.UsedBytes, updatedMb.UsedMb)
			}
			if len(deleted) <= 100 {
				for _, id := range deletedIDs {
					s.liveHub.NotifyMessageDeleted(address, id)
				}
			}
			if len(req.IDs) > 0 && !isClearRoute {
				s.liveHub.NotifyMessagesDeleted(address, deletedIDs)
			} else {
				s.liveHub.NotifyMessagesCleared(address, folder)
			}

			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"success":       true,
				"mailbox":       address,
				"folder":        folder,
				"deleted_count": len(deleted),
				"deleted_ids":   deletedIDs,
				"freed_bytes":   freedBytes,
			})
			return

		default:
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
	}

	if strings.HasSuffix(subPath, "/send") {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		fromAddress := strings.TrimSuffix(subPath, "/send")
		if !s.isMailboxAuthorized(r, fromAddress) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		s.handleMailboxSend(w, r, fromAddress, targetDB, targetStorage)
		return
	}

	address := strings.ToLower(strings.TrimSpace(subPath))
	if r.Method == http.MethodGet {
		if !s.isMailboxAuthorized(r, address) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		mb, err := targetDB.GetMailbox(address)
		if err != nil {
			http.Error(w, "Mailbox not found: "+err.Error(), http.StatusNotFound)
			return
		}
		if user != nil {
			mb.Plan = user.Plan
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"mailbox": mb})
		return
	}

	isAdmin := s.isMailboxAdminAuthorized(r, address)
	isAuthorized := isAdmin || s.isMailboxAuthorized(r, address)
	if !isAuthorized {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	switch r.Method {
	case http.MethodPatch:
		r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
		var req struct {
			DisplayName    *string             `json:"display_name"`
			DisplayNameAlt *string             `json:"displayName"`
			Enabled        *bool               `json:"enabled"`
			Kind           *models.MailboxKind `json:"kind"`
			QuotaBytes     *int64              `json:"quota_bytes"`
			QuotaMb        *float64            `json:"quota_mb"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "Invalid JSON body", http.StatusBadRequest)
			return
		}
		if req.DisplayName == nil && req.DisplayNameAlt != nil {
			req.DisplayName = req.DisplayNameAlt
		}
		if !isAdmin {
			if req.Enabled != nil || req.Kind != nil || req.QuotaBytes != nil || req.QuotaMb != nil {
				http.Error(w, "Forbidden: Only domain admins can modify mailbox status, kind, or quota", http.StatusForbidden)
				return
			}
		}
		var quotaBytes *int64
		if req.QuotaBytes != nil || req.QuotaMb != nil {

			plan := 0
			if user != nil {
				plan = user.Plan
			} else if s.selfHosted || !s.isLiveMode() {
				plan = 1
			}
			if s.isLiveMode() && plan == 0 {
				http.Error(w, "Free plan storage is fixed at 100 MB per mailbox. Upgrade to a paid plan to set custom storage.", http.StatusForbidden)
				return
			}
			var qb int64
			if req.QuotaBytes != nil {
				qb = *req.QuotaBytes
			} else if req.QuotaMb != nil {
				if *req.QuotaMb < 0 {
					http.Error(w, "quota_mb must be >= 0 (0 = unlimited)", http.StatusBadRequest)
					return
				}
				qb = int64(*req.QuotaMb * 1024 * 1024)
			}
			if qb < 0 {
				http.Error(w, "quota_bytes must be >= 0 (0 = unlimited)", http.StatusBadRequest)
				return
			}
			maxQuotaGB := s.maxUserQuotaGB
			if maxQuotaGB <= 0 {
				maxQuotaGB = 50
			}
			maxQuotaBytes := int64(maxQuotaGB * 1024 * 1024 * 1024)
			if qb > maxQuotaBytes {
				http.Error(w, fmt.Sprintf("quota exceeds maximum of %d GB", maxQuotaGB), http.StatusBadRequest)
				return
			}
			if qb > 0 && qb < 1024*1024 {
				http.Error(w, "quota must be 0 (unlimited) or at least 1 MB", http.StatusBadRequest)
				return
			}
			quotaBytes = &qb
		}
		mb, err := targetDB.UpdateMailboxSettings(address, req.Enabled, req.Kind, quotaBytes, req.DisplayName)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if targetDB != s.db {
			_, _ = s.db.UpdateMailboxSettings(address, req.Enabled, req.Kind, quotaBytes, req.DisplayName)
		}

		if req.Enabled != nil && !*req.Enabled {
			if s.userMgr != nil {
				_ = s.userMgr.RevokeMailboxSessionsForAddress(address)
			}
			s.mu.Lock()
			for tok, addr := range s.fallbackTokens {
				if strings.EqualFold(addr, strings.ToLower(strings.TrimSpace(address))) {
					delete(s.fallbackTokens, tok)
				}
			}
			s.mu.Unlock()
		}
		if user != nil {
			mb.Plan = user.Plan
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"mailbox": mb})

	case http.MethodDelete:
		apiKey := s.resolveApiKey(r)
		if apiKey != nil {
			if !apiKey.CanDeleteMailbox() {
				http.Error(w, "Forbidden: API key does not have permission to delete mailbox", http.StatusForbidden)
				return
			}
			if !apiKey.Covers(models.MailboxDomain(address), address) {
				http.Error(w, "Forbidden: API key scope does not cover this mailbox", http.StatusForbidden)
				return
			}
		} else if !isAdmin {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		if err := targetDB.DeleteMailbox(address); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if targetDB != s.db {
			_ = s.db.DeleteMailbox(address)
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"success": true})

	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func formatFromHeader(name, email string) string {
	cleanEmail := strings.TrimSpace(email)
	cleanName := strings.TrimSpace(name)
	if parsed, err := mail.ParseAddress(cleanEmail); err == nil {
		if cleanName == "" && parsed.Name != "" {
			cleanName = parsed.Name
		}
		cleanEmail = parsed.Address
	}
	if cleanName == "" {
		return cleanEmail
	}
	return (&mail.Address{
		Name:    cleanName,
		Address: cleanEmail,
	}).String()
}

func buildMIMEMessage(from string, to []string, subject, body, html string, attachments []*models.Attachment) string {
	var sb strings.Builder
	cleanFrom := mimeutil.SanitizeHeader(from)
	if parsed, err := mail.ParseAddress(cleanFrom); err == nil && parsed.Name != "" {
		cleanFrom = parsed.String()
	}
	cleanSubject := mimeutil.SanitizeHeader(subject)
	var cleanRecipients []string
	for _, t := range to {
		if c := mimeutil.SanitizeHeader(t); c != "" {
			cleanRecipients = append(cleanRecipients, c)
		}
	}
	if cleanFrom == "" || len(cleanRecipients) == 0 {
		return ""
	}

	sb.WriteString(fmt.Sprintf("From: %s\r\n", cleanFrom))
	sb.WriteString(fmt.Sprintf("To: %s\r\n", strings.Join(cleanRecipients, ", ")))
	sb.WriteString(fmt.Sprintf("Subject: %s\r\n", cleanSubject))
	sb.WriteString(fmt.Sprintf("Date: %s\r\n", time.Now().UTC().Format(time.RFC1123Z)))
	sb.WriteString("MIME-Version: 1.0\r\n")

	htmlContent := strings.TrimSpace(html)
	textContent := strings.TrimSpace(body)

	if htmlContent == "" && mimeutil.IsLikelyHTML(body) {
		htmlContent = body
		textContent = mimeutil.HTMLToText(body)
	} else if htmlContent != "" && textContent == "" {
		textContent = mimeutil.HTMLToText(htmlContent)
	}

	hasAttachments := false
	for _, a := range attachments {
		if a != nil && len(a.Data) > 0 {
			hasAttachments = true
			break
		}
	}

	if hasAttachments {
		mixedBoundary := fmt.Sprintf("====_mailergo_%d_mixed====", time.Now().UnixNano())
		sb.WriteString(fmt.Sprintf("Content-Type: multipart/mixed; boundary=\"%s\"\r\n\r\n", mixedBoundary))

		sb.WriteString(fmt.Sprintf("--%s\r\n", mixedBoundary))
		if htmlContent != "" {
			altBoundary := fmt.Sprintf("====_mailergo_%d_alt====", time.Now().UnixNano())
			sb.WriteString(fmt.Sprintf("Content-Type: multipart/alternative; boundary=\"%s\"\r\n\r\n", altBoundary))

			sb.WriteString(fmt.Sprintf("--%s\r\n", altBoundary))
			sb.WriteString("Content-Type: text/plain; charset=UTF-8\r\n")
			sb.WriteString("Content-Transfer-Encoding: quoted-printable\r\n\r\n")
			sb.WriteString(mimeutil.EncodeQuotedPrintable(textContent))

			sb.WriteString(fmt.Sprintf("--%s\r\n", altBoundary))
			sb.WriteString("Content-Type: text/html; charset=UTF-8\r\n")
			sb.WriteString("Content-Transfer-Encoding: quoted-printable\r\n\r\n")
			sb.WriteString(mimeutil.EncodeQuotedPrintable(htmlContent))

			sb.WriteString(fmt.Sprintf("--%s--\r\n", altBoundary))
		} else {
			sb.WriteString("Content-Type: text/plain; charset=UTF-8\r\n")
			sb.WriteString("Content-Transfer-Encoding: quoted-printable\r\n\r\n")
			sb.WriteString(mimeutil.EncodeQuotedPrintable(textContent))
		}

		for _, att := range attachments {
			if att == nil || len(att.Data) == 0 {
				continue
			}
			fn := mimeutil.SanitizeHeader(filepath.Base(att.Filename))
			if fn == "" {
				fn = "attachment"
			}
			ct := strings.TrimSpace(att.ContentType)
			if ct == "" {
				ct = "application/octet-stream"
			}
			sb.WriteString(fmt.Sprintf("--%s\r\n", mixedBoundary))
			sb.WriteString(fmt.Sprintf("Content-Type: %s; name=\"%s\"\r\n", ct, fn))
			if att.ContentID != "" {
				cleanCID := strings.Trim(strings.TrimSpace(att.ContentID), "<>")
				sb.WriteString(fmt.Sprintf("Content-ID: <%s>\r\n", cleanCID))
			}
			if att.IsInline {
				sb.WriteString(fmt.Sprintf("Content-Disposition: inline; filename=\"%s\"\r\n", fn))
			} else {
				sb.WriteString(fmt.Sprintf("Content-Disposition: attachment; filename=\"%s\"\r\n", fn))
			}
			sb.WriteString("Content-Transfer-Encoding: base64\r\n\r\n")
			encoded := base64.StdEncoding.EncodeToString(att.Data)
			for i := 0; i < len(encoded); i += 76 {
				end := i + 76
				if end > len(encoded) {
					end = len(encoded)
				}
				sb.WriteString(encoded[i:end])
				sb.WriteString("\r\n")
			}
			sb.WriteString("\r\n")
		}

		sb.WriteString(fmt.Sprintf("--%s--\r\n", mixedBoundary))
	} else if htmlContent != "" {
		boundary := fmt.Sprintf("====_mailergo_%d_alt====", time.Now().UnixNano())
		sb.WriteString(fmt.Sprintf("Content-Type: multipart/alternative; boundary=\"%s\"\r\n\r\n", boundary))

		sb.WriteString(fmt.Sprintf("--%s\r\n", boundary))
		sb.WriteString("Content-Type: text/plain; charset=UTF-8\r\n")
		sb.WriteString("Content-Transfer-Encoding: quoted-printable\r\n\r\n")
		sb.WriteString(mimeutil.EncodeQuotedPrintable(textContent))

		sb.WriteString(fmt.Sprintf("--%s\r\n", boundary))
		sb.WriteString("Content-Type: text/html; charset=UTF-8\r\n")
		sb.WriteString("Content-Transfer-Encoding: quoted-printable\r\n\r\n")
		sb.WriteString(mimeutil.EncodeQuotedPrintable(htmlContent))

		sb.WriteString(fmt.Sprintf("--%s--\r\n", boundary))
	} else {
		sb.WriteString("Content-Type: text/plain; charset=UTF-8\r\n")
		sb.WriteString("Content-Transfer-Encoding: quoted-printable\r\n\r\n")
		sb.WriteString(mimeutil.EncodeQuotedPrintable(textContent))
	}

	return sb.String()
}

func (s *APIServer) handleMailboxSend(w http.ResponseWriter, r *http.Request, fromAddress string, targetDB *db.DB, targetStorage *storage.Storage) {
	if targetDB == nil {
		targetDB = s.db
	}
	if targetStorage == nil {
		targetStorage = s.storage
	}

	r.Body = http.MaxBytesReader(w, r.Body, 64<<20)
	var req struct {
		FromName    string               `json:"from_name"`
		FromNameAlt string               `json:"fromName"`
		To          interface{}          `json:"to"`
		Subject     string               `json:"subject"`
		Body        string               `json:"body"`
		HTML        string               `json:"html"`
		Attachments []*models.Attachment `json:"attachments"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request JSON: "+err.Error(), http.StatusBadRequest)
		return
	}
	if req.FromName == "" && req.FromNameAlt != "" {
		req.FromName = req.FromNameAlt
	}

	var toRecipients []string
	switch v := req.To.(type) {
	case string:
		clean := strings.TrimSpace(v)
		if clean != "" {
			toRecipients = []string{clean}
		}
	case []interface{}:
		for _, item := range v {
			if s, ok := item.(string); ok && strings.TrimSpace(s) != "" {
				toRecipients = append(toRecipients, strings.TrimSpace(s))
			}
		}
	case []string:
		toRecipients = v
	}

	if len(toRecipients) == 0 {
		http.Error(w, "At least one recipient in 'to' is required", http.StatusBadRequest)
		return
	}

	u := s.resolveUser(r)
	if u == nil {
		_, _, u = s.resolveDBForAddress(r, fromAddress)
	}

	fromDisplayName := strings.TrimSpace(req.FromName)

	if mb, err := s.lookupMailboxAnywhere(targetDB, fromAddress); err == nil && mb != nil {
		if !mb.Enabled {
			http.Error(w, "Mailbox is disabled and cannot send mail. Re-enable it to resume sending.", http.StatusForbidden)
			return
		}
		if fromDisplayName == "" {
			fromDisplayName = strings.TrimSpace(mb.DisplayName)
		}
		if s.isLiveMode() {
			plan := 0
			if u != nil {
				plan = u.Plan
			}
			if limit := mb.EffectiveQuotaBytes(plan, true); limit > 0 {
				if mb.UsedBytes >= limit {
					http.Error(w, fmt.Sprintf("Mailbox quota exceeded: %s storage limit reached. Please delete emails to free up storage before sending.", formatBytes(limit)), http.StatusForbidden)
					return
				}
			}
		}
	} else if s.isLiveMode() && u != nil && u.Plan == 0 {
		if mb, err := targetDB.GetMailbox(fromAddress); err == nil && mb != nil {
			if fromDisplayName == "" {
				fromDisplayName = strings.TrimSpace(mb.DisplayName)
			}
			mailboxQuotaMB := s.defaultMailboxQuotaMB
			if mailboxQuotaMB <= 0 {
				mailboxQuotaMB = 100
			}
			maxMailboxBytes := mailboxQuotaMB * 1024 * 1024
			if mb.UsedBytes >= maxMailboxBytes {
				http.Error(w, fmt.Sprintf("Mailbox quota exceeded: %d MB storage limit reached. Please delete emails to free up storage before sending.", mailboxQuotaMB), http.StatusForbidden)
				return
			}
		}
	}

	fromHeader := formatFromHeader(fromDisplayName, fromAddress)
	rawEML := buildMIMEMessage(fromHeader, toRecipients, req.Subject, req.Body, req.HTML, req.Attachments)

	outboundReq := &models.OutboundSendRequest{
		From:        fromHeader,
		FromName:    fromDisplayName,
		To:          toRecipients,
		Subject:     req.Subject,
		Body:        req.Body,
		HTML:        req.HTML,
		Raw:         rawEML,
		Attachments: req.Attachments,
	}

	var sendResp *models.OutboundSendResponse
	if s.client != nil {
		resp, err := s.client.SendOutboundMail(outboundReq)
		if err != nil {
			http.Error(w, "Outbound relay send failed: "+err.Error(), http.StatusInternalServerError)
			return
		}
		sendResp = resp
	} else {
		sendResp = &models.OutboundSendResponse{
			Success: true,
			MailID:  fmt.Sprintf("msg_mock_%d", time.Now().UnixNano()),
			Message: "queued_offline",
		}
	}

	msgID := sendResp.MailID
	if msgID == "" {
		msgID = fmt.Sprintf("msg_%d", time.Now().UnixNano())
	}

	rawPath, err := targetStorage.SaveRawMessage(fromAddress, msgID, []byte(rawEML))
	if err != nil {
		log.Printf("[STORAGE WARNING] Failed to persist sent .eml: %v", err)
	}

	var savedAttachments []*models.Attachment
	for _, att := range req.Attachments {
		if att == nil || len(att.Data) == 0 {
			continue
		}
		fn := mimeutil.SanitizeHeader(filepath.Base(att.Filename))
		if fn == "" {
			fn = "attachment"
		}
		ct := strings.TrimSpace(att.ContentType)
		if ct == "" {
			ct = "application/octet-stream"
		}
		savedAtt, err := targetStorage.SaveAttachment(msgID, fromAddress, fn, ct, att.Data)
		if err != nil {
			log.Printf("[STORAGE WARNING] Failed to persist outbound attachment %s: %v", fn, err)
			continue
		}
		savedAtt.MessageID = msgID
		savedAtt.Mailbox = fromAddress
		savedAttachments = append(savedAttachments, savedAtt)
	}

	bodyPlain := req.Body
	bodyHTML := req.HTML
	if bodyHTML == "" && mimeutil.IsLikelyHTML(bodyPlain) {
		bodyHTML = bodyPlain
		bodyPlain = mimeutil.HTMLToText(bodyPlain)
	} else if bodyHTML != "" && strings.TrimSpace(bodyPlain) == "" {
		bodyPlain = mimeutil.HTMLToText(bodyHTML)
	}

	sizeBytes := int64(len(rawEML))
	storedMsg := &models.StoredMessage{
		ID:          msgID,
		Mailbox:     fromAddress,
		Folder:      "sent",
		From:        fromHeader,
		To:          strings.Join(toRecipients, ", "),
		Subject:     req.Subject,
		Body:        bodyPlain,
		BodyHTML:    bodyHTML,
		RawPath:     rawPath,
		SizeBytes:   sizeBytes,
		Date:        time.Now().UTC().Format(time.RFC3339),
		Read:        true,
		Starred:     false,
		Attachments: savedAttachments,
		CreatedAt:   time.Now().Unix(),
	}

	if err := targetDB.CreateMessage(storedMsg); err != nil {
		log.Printf("[DB WARNING] Failed to record sent message in DB: %v", err)
	}

	if updatedMb, err := targetDB.GetMailbox(fromAddress); err == nil {
		s.liveHub.NotifyMailboxUsage(fromAddress, updatedMb.UsedBytes, updatedMb.UsedMb)
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"message": storedMsg,
		"id":      msgID,
		"relay":   sendResp,
	})
}

func (s *APIServer) handleMessages(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	if r.Method != http.MethodDelete && r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Mailbox string   `json:"mailbox"`
		Folder  string   `json:"folder"`
		IDs     []string `json:"ids"`
		All     bool     `json:"all"`
	}
	if r.Body != nil {
		_ = json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req)
	}

	if len(req.IDs) == 0 {
		if idsParam := strings.TrimSpace(r.URL.Query().Get("ids")); idsParam != "" {
			parts := strings.Split(idsParam, ",")
			for _, p := range parts {
				if cleanID := strings.TrimSpace(p); cleanID != "" {
					req.IDs = append(req.IDs, cleanID)
				}
			}
		}
	}
	if req.Mailbox == "" {
		req.Mailbox = strings.TrimSpace(r.URL.Query().Get("mailbox"))
	}
	if req.Folder == "" {
		req.Folder = strings.TrimSpace(r.URL.Query().Get("folder"))
	}
	if !req.All && (r.URL.Query().Get("all") == "true" || strings.EqualFold(req.Folder, "all") || req.Folder == "*") {
		req.All = true
	}

	token := extractBearerToken(r)
	var activeMailbox string
	if token != "" {
		activeMailbox = s.authenticateMailboxToken(token)
	}

	if req.Mailbox == "" && len(req.IDs) == 0 && activeMailbox != "" {
		req.Mailbox = activeMailbox
	}

	if req.Mailbox != "" && len(req.IDs) == 0 {
		cleanMb := strings.ToLower(strings.TrimSpace(req.Mailbox))
		if !s.isMailboxAuthorized(r, cleanMb) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		if apiKey := s.resolveApiKey(r); apiKey != nil && !apiKey.CanDeleteMailbox() {
			http.Error(w, "Forbidden: API key does not have permission to clear/delete mailbox", http.StatusForbidden)
			return
		}

		targetDB, targetStorage, _ := s.resolveDBForAddress(r, cleanMb)
		folder := strings.ToLower(strings.TrimSpace(req.Folder))
		if req.All || folder == "all" || folder == "*" {
			folder = "all"
		} else if folder == "" {
			folder = "inbox"
		}

		deleted, err := targetDB.ClearMessages(cleanMb, folder)
		if err == nil && targetDB != s.db {
			_, _ = s.db.ClearMessages(cleanMb, folder)
		}
		if err != nil {
			http.Error(w, "Failed to clear messages: "+err.Error(), http.StatusInternalServerError)
			return
		}

		var freedBytes int64
		deletedIDs := make([]string, 0, len(deleted))
		for _, m := range deleted {
			deletedIDs = append(deletedIDs, m.ID)
			freedBytes += m.SizeBytes
			if m.RawPath != "" {
				if err := targetStorage.DeleteRawMessage(m.RawPath); err != nil && targetStorage != s.storage {
					_ = s.storage.DeleteRawMessage(m.RawPath)
				}
			}
			if s.store != nil {
				s.store.Remove(m.ID)
			}
		}

		if updatedMb, err := targetDB.GetMailbox(cleanMb); err == nil && updatedMb != nil {
			s.liveHub.NotifyMailboxUsage(cleanMb, updatedMb.UsedBytes, updatedMb.UsedMb)
		}
		if len(deleted) <= 100 {
			for _, id := range deletedIDs {
				s.liveHub.NotifyMessageDeleted(cleanMb, id)
			}
		}
		s.liveHub.NotifyMessagesCleared(cleanMb, folder)

		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"success":       true,
			"mailbox":       cleanMb,
			"folder":        folder,
			"deleted_count": len(deleted),
			"deleted_ids":   deletedIDs,
			"freed_bytes":   freedBytes,
		})
		return
	}

	if len(req.IDs) > 0 {
		if apiKey := s.resolveApiKey(r); apiKey != nil && !apiKey.CanDeleteMessages() {
			http.Error(w, "Forbidden: API key does not have permission to delete messages", http.StatusForbidden)
			return
		}
		var allDeleted []*models.StoredMessage
		var totalFreedBytes int64
		affectedMailboxes := make(map[string]bool)

		messagesByMailbox := make(map[string][]string)
		for _, id := range req.IDs {
			cleanID := strings.TrimSpace(id)
			if cleanID == "" {
				continue
			}

			var msg *models.StoredMessage
			if activeMailbox != "" {
				udb, _, _ := s.resolveDBForAddress(r, activeMailbox)
				if m, err := udb.GetMessage(cleanID); err == nil && m != nil {
					msg = m
				}
			}
			if msg == nil && req.Mailbox != "" {
				mbDB, _, _ := s.resolveDBForAddress(r, req.Mailbox)
				if mbDB != nil {
					if m, err := mbDB.GetMessage(cleanID); err == nil && m != nil {
						msg = m
					}
				}
			}
			if msg == nil && s.db != nil {
				if m, err := s.db.GetMessage(cleanID); err == nil && m != nil {
					msg = m
				}
			}
			if msg == nil {
				udb, _, _ := s.resolveDB(r)
				if udb != nil && udb != s.db {
					if m, err := udb.GetMessage(cleanID); err == nil && m != nil {
						msg = m
					}
				}
			}
			if msg == nil && s.userMgr != nil {
				if apiKey := s.resolveApiKey(r); apiKey != nil {
					for _, d := range apiKey.Domains {
						if uid, uerr := s.userMgr.GetUserIDByDomain(d); uerr == nil && uid != "" {
							if udb, uerr2 := s.userMgr.GetUserDB(uid); uerr2 == nil && udb != nil && udb != s.db {
								if m, uerr3 := udb.GetMessage(cleanID); uerr3 == nil && m != nil {
									msg = m
									break
								}
							}
						}
					}
				}
			}

			if msg == nil {
				continue
			}

			if !s.isMailboxAuthorized(r, msg.Mailbox) {
				http.Error(w, fmt.Sprintf("Unauthorized to delete message in mailbox %s", msg.Mailbox), http.StatusForbidden)
				return
			}

			messagesByMailbox[strings.ToLower(msg.Mailbox)] = append(messagesByMailbox[strings.ToLower(msg.Mailbox)], cleanID)
		}

		for mb, mbIDs := range messagesByMailbox {
			targetDB, targetStorage, _ := s.resolveDBForAddress(r, mb)
			deleted, err := targetDB.DeleteMailboxMessagesByIDs(mb, mbIDs)
			if err == nil && targetDB != s.db {
				_, _ = s.db.DeleteMailboxMessagesByIDs(mb, mbIDs)
			}
			if err != nil {
				http.Error(w, "Failed to delete messages: "+err.Error(), http.StatusInternalServerError)
				return
			}
			affectedMailboxes[mb] = true
			for _, m := range deleted {
				allDeleted = append(allDeleted, m)
				totalFreedBytes += m.SizeBytes
				if m.RawPath != "" {
					if err := targetStorage.DeleteRawMessage(m.RawPath); err != nil && targetStorage != s.storage {
						_ = s.storage.DeleteRawMessage(m.RawPath)
					}
				}
				if s.store != nil {
					s.store.Remove(m.ID)
				}
			}
		}

		deletedIDs := make([]string, 0, len(allDeleted))
		for _, m := range allDeleted {
			deletedIDs = append(deletedIDs, m.ID)
		}

		for mb := range affectedMailboxes {
			targetDB, _, _ := s.resolveDBForAddress(r, mb)
			if updatedMb, err := targetDB.GetMailbox(mb); err == nil && updatedMb != nil {
				s.liveHub.NotifyMailboxUsage(mb, updatedMb.UsedBytes, updatedMb.UsedMb)
			}
			if len(allDeleted) <= 100 {
				for _, m := range allDeleted {
					if strings.EqualFold(m.Mailbox, mb) {
						s.liveHub.NotifyMessageDeleted(mb, m.ID)
					}
				}
			}
			s.liveHub.NotifyMessagesDeleted(mb, deletedIDs)
		}

		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"success":       true,
			"deleted_count": len(allDeleted),
			"deleted_ids":   deletedIDs,
			"freed_bytes":   totalFreedBytes,
		})
		return
	}

	http.Error(w, "Invalid request: specify 'ids' or 'mailbox' to clear", http.StatusBadRequest)
}

func (s *APIServer) handleMessageByID(w http.ResponseWriter, r *http.Request) {
	msgID := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/messages/"), "/")
	if msgID == "" || msgID == "batch-delete" || msgID == "delete" || msgID == "clear" {
		s.handleMessages(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/json")

	token := extractBearerToken(r)
	var activeMailbox string
	if token != "" {
		activeMailbox = s.authenticateMailboxToken(token)
	}

	var targetDB *db.DB
	var targetStorage *storage.Storage
	if activeMailbox != "" {
		targetDB, targetStorage, _ = s.resolveDBForAddress(r, activeMailbox)
	} else {
		targetDB, targetStorage, _ = s.resolveDB(r)
	}

	msg, err := targetDB.GetMessage(msgID)
	if err != nil && targetDB != s.db {
		msg, err = s.db.GetMessage(msgID)
	}
	if (err != nil || msg == nil) && s.userMgr != nil {
		if apiKey := s.resolveApiKey(r); apiKey != nil {
			for _, d := range apiKey.Domains {
				if uid, uerr := s.userMgr.GetUserIDByDomain(d); uerr == nil && uid != "" {
					if udb, uerr2 := s.userMgr.GetUserDB(uid); uerr2 == nil && udb != nil && udb != targetDB {
						if m, uerr3 := udb.GetMessage(msgID); uerr3 == nil && m != nil {
							msg = m
							targetDB = udb
							if ustore, uerr4 := s.userMgr.GetUserStorage(uid); uerr4 == nil && ustore != nil {
								targetStorage = ustore
							}
							err = nil
							break
						}
					}
				}
			}
		}
	}
	if err != nil || msg == nil {
		http.Error(w, "Message not found", http.StatusNotFound)
		return
	}

	if !s.isMailboxAuthorized(r, msg.Mailbox) {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	switch r.Method {
	case http.MethodGet:
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"message": msg})
	case http.MethodPatch:
		r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
		var req struct {
			Read    *bool   `json:"read"`
			Starred *bool   `json:"starred"`
			Folder  *string `json:"folder"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "Invalid JSON body", http.StatusBadRequest)
			return
		}

		if req.Read != nil {
			_ = targetDB.UpdateMessageRead(msgID, *req.Read)
			if targetDB != s.db {
				_ = s.db.UpdateMessageRead(msgID, *req.Read)
			}
		}
		if req.Starred != nil {
			_ = targetDB.UpdateMessageStarred(msgID, *req.Starred)
			if targetDB != s.db {
				_ = s.db.UpdateMessageStarred(msgID, *req.Starred)
			}
		}
		if req.Folder != nil {
			folder := strings.ToLower(strings.TrimSpace(*req.Folder))
			switch folder {
			case "inbox", "sent", "drafts", "trash", "spam", "archive":
			default:
				http.Error(w, "Invalid folder", http.StatusBadRequest)
				return
			}
			_ = targetDB.MoveMessageFolder(msgID, folder)
			if targetDB != s.db {
				_ = s.db.MoveMessageFolder(msgID, folder)
			}
		}

		_ = json.NewEncoder(w).Encode(map[string]interface{}{"success": true})

	case http.MethodDelete:
		if apiKey := s.resolveApiKey(r); apiKey != nil && !apiKey.CanDeleteMessages() {
			http.Error(w, "Forbidden: API key does not have permission to delete messages", http.StatusForbidden)
			return
		}
		deletedMsg, err := targetDB.DeleteMessage(msgID)
		if err != nil && targetDB != s.db {
			deletedMsg, err = s.db.DeleteMessage(msgID)
		}
		if err != nil {
			http.Error(w, "Failed to delete message: "+err.Error(), http.StatusInternalServerError)
			return
		}

		if deletedMsg != nil && deletedMsg.RawPath != "" {
			if err := targetStorage.DeleteRawMessage(deletedMsg.RawPath); err != nil && targetStorage != s.storage {
				_ = s.storage.DeleteRawMessage(deletedMsg.RawPath)
			}
		}

		if deletedMsg != nil {
			if updatedMb, err := targetDB.GetMailbox(deletedMsg.Mailbox); err == nil {
				s.liveHub.NotifyMailboxUsage(deletedMsg.Mailbox, updatedMb.UsedBytes, updatedMb.UsedMb)
			}
			s.liveHub.NotifyMessageDeleted(deletedMsg.Mailbox, msgID)
		}

		_ = json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "id": msgID})

	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *APIServer) handleAttachments(w http.ResponseWriter, r *http.Request) {
	subPath := strings.TrimPrefix(r.URL.Path, "/api/attachments/")
	isDownload := strings.HasSuffix(subPath, "/download")
	isView := strings.HasSuffix(subPath, "/view")
	attID := subPath

	if isDownload {
		attID = strings.TrimSuffix(subPath, "/download")
	} else if isView {
		attID = strings.TrimSuffix(subPath, "/view")
	}

	attID = strings.Trim(attID, "/")
	if attID == "" {
		http.Error(w, "Attachment ID required", http.StatusBadRequest)
		return
	}

	token := extractBearerToken(r)
	var activeMailbox string
	if token != "" {
		activeMailbox = s.authenticateMailboxToken(token)
	}

	var targetDB *db.DB
	if activeMailbox != "" {
		targetDB, _, _ = s.resolveDBForAddress(r, activeMailbox)
	} else {
		targetDB, _, _ = s.resolveDB(r)
	}

	att, err := targetDB.GetAttachment(attID)
	if err != nil && targetDB != s.db {
		att, err = s.db.GetAttachment(attID)
	}

	if err != nil && s.userMgr != nil {
		users, _ := s.userMgr.ListUsers()
		for _, u := range users {
			if udb, err2 := s.userMgr.GetUserDB(u.ID); err2 == nil && udb != nil {
				if found, err3 := udb.GetAttachment(attID); err3 == nil && found != nil {
					att = found
					err = nil
					break
				}
			}
		}
	}

	if err != nil || att == nil {
		http.Error(w, "Attachment not found", http.StatusNotFound)
		return
	}

	mailbox := att.Mailbox
	if mailbox == "" && att.MessageID != "" {
		if msg, _ := targetDB.GetMessage(att.MessageID); msg != nil {
			mailbox = msg.Mailbox
		} else if targetDB != s.db {
			if msg, _ := s.db.GetMessage(att.MessageID); msg != nil {
				mailbox = msg.Mailbox
			}
		}
	}
	if mailbox == "" || !s.isMailboxAuthorized(r, mailbox) {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	if att.StoragePath == "" {
		http.Error(w, "Attachment file path not found", http.StatusNotFound)
		return
	}

	targetStorage := s.storage
	if att.Mailbox != "" {
		if _, ustore, _ := s.resolveDBForAddress(r, att.Mailbox); ustore != nil {
			targetStorage = ustore
		}
	} else if activeMailbox != "" {
		if _, ustore, _ := s.resolveDBForAddress(r, activeMailbox); ustore != nil {
			targetStorage = ustore
		}
	}

	f, err := targetStorage.OpenAttachment(att.StoragePath)
	if err != nil && targetStorage != s.storage && s.storage != nil {
		f, err = s.storage.OpenAttachment(att.StoragePath)
	}
	if err != nil {
		http.Error(w, "Attachment file not found", http.StatusNotFound)
		return
	}
	defer f.Close()

	contentType := strings.TrimSpace(att.ContentType)
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	if i := strings.Index(contentType, ";"); i != -1 {
		contentType = strings.TrimSpace(contentType[:i])
	}

	lowerCT := strings.ToLower(contentType)

	isDangerousContent := strings.HasPrefix(lowerCT, "text/html") ||
		strings.Contains(lowerCT, "svg") ||
		strings.HasPrefix(lowerCT, "application/xhtml") ||
		strings.Contains(lowerCT, "javascript") ||
		strings.Contains(lowerCT, "xml") ||
		strings.EqualFold(lowerCT, "application/x-msdownload") ||
		strings.EqualFold(lowerCT, "application/x-executable")

	safeName := strings.ReplaceAll(strings.ReplaceAll(att.Filename, "\r", "_"), "\n", "_")
	safeName = strings.ReplaceAll(safeName, "\"", "_")
	safeName = filepath.Base(strings.ReplaceAll(safeName, "\\", "/"))
	if safeName == "" || safeName == "." || safeName == "/" {
		safeName = "attachment"
	}

	isSafeImage := lowerCT == "image/png" || lowerCT == "image/jpeg" || lowerCT == "image/jpg" ||
		lowerCT == "image/gif" || lowerCT == "image/webp" || lowerCT == "image/bmp" ||
		lowerCT == "image/x-icon" || lowerCT == "image/vnd.microsoft.icon"

	if isDangerousContent {
		contentType = "application/octet-stream"
	}

	if isView && isSafeImage && !isDangerousContent {
		w.Header().Set("Content-Disposition", fmt.Sprintf("inline; filename=%q", safeName))
	} else {
		w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", safeName))
	}

	w.Header().Set("Content-Type", contentType)
	if att.SizeBytes > 0 {
		w.Header().Set("Content-Length", strconv.FormatInt(att.SizeBytes, 10))
	}
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	_, _ = io.Copy(w, f)
}

func (s *APIServer) handleDomainSubroutes(w http.ResponseWriter, r *http.Request) {
	subPath := strings.TrimPrefix(r.URL.Path, "/api/domains/")
	w.Header().Set("Content-Type", "application/json")
	targetDB, _, u := s.resolveDB(r)

	if u == nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	cleanDomain := strings.ToLower(strings.TrimSpace(strings.Split(subPath, "/")[0]))
	if cleanDomain != "" && !s.ownsDomain(u, cleanDomain) {
		http.Error(w, "Forbidden: you do not own this domain", http.StatusForbidden)
		return
	}

	if strings.Contains(subPath, "/mailboxes") {
		domain := cleanDomain
		switch r.Method {
		case http.MethodGet:
			list, err := targetDB.ListMailboxes(domain)
			if err != nil {
				http.Error(w, "Failed to list mailboxes: "+err.Error(), http.StatusInternalServerError)
				return
			}
			if list == nil {
				list = []*models.Mailbox{}
			}
			plan := 0
			if u != nil {
				plan = u.Plan
			}
			for _, m := range list {
				m.Plan = plan
			}
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"mailboxes": list})

		case http.MethodPost:
			r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
			var req struct {
				Local    string `json:"local"`
				Password string `json:"password"`
				Kind     string `json:"kind"`
			}
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				http.Error(w, "Invalid JSON body", http.StatusBadRequest)
				return
			}

			if s.isLiveMode() && u != nil && u.Plan == 0 {
				existing, _ := targetDB.ListMailboxes(domain)
				if len(existing) >= 5 {
					http.Error(w, "Free plan limit reached: maximum 5 mailboxes allowed per domain. Administrator accounts have unlimited mailboxes.", http.StatusForbidden)
					return
				}
				allBoxes, _ := targetDB.ListAllMailboxes()
				if len(allBoxes) >= 5 {
					http.Error(w, "Free plan limit reached: maximum 5 mailboxes allowed per account. Administrator accounts have unlimited mailboxes.", http.StatusForbidden)
					return
				}
			}

			mb, err := targetDB.CreateMailbox(domain, req.Local, req.Password, req.Kind)
			if err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			if u != nil {
				mb.Plan = u.Plan
			}
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"mailbox": mb})

		default:
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
		return
	}

	if strings.Contains(subPath, "/verify") {
		domain := strings.Split(subPath, "/")[0]
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		allowed, retryAfter := s.dnsChecker.CheckRateLimit(domain)
		if !allowed {
			w.Header().Set("Retry-After", fmt.Sprintf("%d", retryAfter))
			w.WriteHeader(http.StatusTooManyRequests)
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"error": "Rate limit exceeded"})
			return
		}

		result, updatedDom, err := s.verifyDomainLogic(targetDB, domain, u)
		if err != nil {
			http.Error(w, "DNS check failed: "+err.Error(), http.StatusInternalServerError)
			return
		}

		type DnsRec struct {
			Kind   string `json:"kind"`
			Host   string `json:"host"`
			Value  string `json:"value"`
			Status string `json:"status"`
		}
		var dnsList []DnsRec
		for _, rec := range result.Records {
			st := "fail"
			if rec.Status == "verified" {
				st = "ok"
			}
			dnsList = append(dnsList, DnsRec{
				Kind:   rec.Type,
				Host:   rec.Name,
				Value:  rec.Value,
				Status: st,
			})
		}

		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"dns":          dnsList,
			"records":      result.Records,
			"all_verified": result.AllVerified,
			"domain":       updatedDom.Name,
			"is_active":    updatedDom.IsActive,
		})
		return
	}

	if strings.Contains(subPath, "/templates") {
		domain := strings.Split(subPath, "/")[0]
		switch r.Method {
		case http.MethodGet:
			list, err := targetDB.ListTemplatesByDomain(domain)
			if err != nil {
				http.Error(w, "Failed to list templates: "+err.Error(), http.StatusInternalServerError)
				return
			}
			if list == nil {
				list = []*models.MailTemplate{}
			}
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"templates": list})
			return
		case http.MethodPost:
			r.Body = http.MaxBytesReader(w, r.Body, 5<<20)
			var req struct {
				Name    string `json:"name"`
				Subject string `json:"subject"`
				HTML    string `json:"html"`
				Text    string `json:"text"`
				Mailbox string `json:"mailbox"`
			}
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				http.Error(w, "Invalid JSON body", http.StatusBadRequest)
				return
			}
			mb := req.Mailbox
			if mb == "" {
				mb = "*@" + domain
			}
			tpl, err := targetDB.UpsertTemplate(domain, mb, req.Name, req.Subject, req.HTML, req.Text)
			if err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			if targetDB != s.db {
				_, _ = s.db.UpsertTemplate(domain, mb, req.Name, req.Subject, req.HTML, req.Text)
			}
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"template": tpl})
			return
		default:
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
	}

	if strings.Contains(subPath, "/subscriptions") {
		domain := strings.Split(subPath, "/")[0]
		switch r.Method {
		case http.MethodGet:
			list, err := targetDB.ListSubscriptions(domain)
			if err != nil {
				http.Error(w, "Failed to list subscriptions: "+err.Error(), http.StatusInternalServerError)
				return
			}
			if list == nil {
				list = []*models.Subscription{}
			}
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"subscriptions": list})
		case http.MethodPost:
			r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
			var req struct {
				URL    string   `json:"url"`
				Events []string `json:"events"`
			}
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				http.Error(w, "Invalid JSON body", http.StatusBadRequest)
				return
			}
			if err := validateWebhookURL(req.URL); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			sub, secret, err := targetDB.CreateSubscription(domain, req.URL, req.Events)
			if err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"subscription": sub,
				"secret":       secret,
			})
		default:
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
		return
	}

	if strings.Contains(subPath, "/mx") {
		domain := strings.Split(subPath, "/")[0]
		if r.Method != http.MethodPut {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		dom, err := targetDB.GetDomain(domain)
		if err != nil && targetDB != s.db {
			dom, err = s.db.GetDomain(domain)
		}
		if err != nil {
			http.Error(w, "Domain not found", http.StatusNotFound)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"domain": s.toFrontDomain(dom)})
		return
	}

	domain := subPath
	if r.Method == http.MethodGet {
		dom, _ := s.resolveAnyDomain(targetDB, domain)
		if dom == nil {
			http.Error(w, "Domain not found", http.StatusNotFound)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"domain": s.toFrontDomain(dom)})
		return
	}
	if r.Method == http.MethodDelete {
		s.deletePendingDomain(domain)
		deletedDom, err := targetDB.DeleteDomain(domain)
		if err != nil && targetDB != s.db {
			deletedDom, err = s.db.DeleteDomain(domain)
		} else if targetDB != s.db {
			_, _ = s.db.DeleteDomain(domain)
		}
		if s.userMgr != nil {
			_ = s.userMgr.DisassociateDomain(domain)
		}
		if deletedDom != nil {
			s.syncPusher.TriggerPush()
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "domain": domain})
		return
	}

	http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
}

func extractBearerToken(r *http.Request) string {
	authHeader := strings.TrimSpace(r.Header.Get("Authorization"))
	if strings.HasPrefix(strings.ToLower(authHeader), "bearer ") {
		return strings.TrimSpace(authHeader[7:])
	}
	if cookie, err := r.Cookie("token"); err == nil && cookie.Value != "" {
		return strings.TrimSpace(cookie.Value)
	}
	if cookie, err := r.Cookie("mailbox_token"); err == nil && cookie.Value != "" {
		return strings.TrimSpace(cookie.Value)
	}

	if r.Method == http.MethodGet {
		return strings.TrimSpace(r.URL.Query().Get("token"))
	}
	return ""
}

func (s *APIServer) createMailboxToken(address string) (string, error) {
	if s.userMgr != nil {
		return s.userMgr.CreateMailboxSession(address)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tok := fmt.Sprintf("mg_mbx_%d", time.Now().UnixNano())
	s.fallbackTokens[tok] = strings.ToLower(strings.TrimSpace(address))
	return tok, nil
}

func (s *APIServer) authenticateMailboxToken(token string) string {
	clean := strings.TrimSpace(token)
	if clean == "" {
		return ""
	}
	if s.userMgr != nil {
		if addr, err := s.userMgr.AuthenticateMailboxSession(clean); err == nil {
			return addr
		}
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.fallbackTokens[clean]
}

func (s *APIServer) isMailboxAuthorized(r *http.Request, targetAddress string) bool {
	cleanAddr := strings.ToLower(strings.TrimSpace(targetAddress))
	if cleanAddr == "" {
		return false
	}

	token := extractBearerToken(r)
	if token != "" {
		mbxAddr := s.authenticateMailboxToken(token)
		if mbxAddr != "" && strings.ToLower(mbxAddr) == cleanAddr {

			if mb, err := s.lookupMailboxAnywhere(nil, cleanAddr); err == nil && mb != nil && !mb.Enabled {

			} else {
				return true
			}
		}
	}

	u := s.resolveUser(r)
	if u != nil {
		if s.isAdmin(u) {
			return true
		}
		parts := strings.Split(cleanAddr, "@")
		if len(parts) == 2 {
			domain := parts[1]
			if s.userMgr != nil {
				if ownerID, err := s.userMgr.GetUserIDByDomain(domain); err == nil && ownerID == u.ID {
					return true
				}
			}
		}
	}

	keyStr := bearerKey(r)
	if keyStr != "" {
		if key := s.authenticateApiKeyAnywhere(keyStr); key != nil {
			parts := strings.Split(cleanAddr, "@")
			domain := ""
			if len(parts) == 2 {
				domain = parts[1]
			}
			if key.Covers(domain, cleanAddr) {
				return true
			}
		}
	}

	return false
}

func (s *APIServer) isMailboxAdminAuthorized(r *http.Request, targetAddress string) bool {
	cleanAddr := strings.ToLower(strings.TrimSpace(targetAddress))
	u := s.resolveUser(r)
	if u == nil {
		return false
	}
	if s.isAdmin(u) {
		return true
	}
	parts := strings.Split(cleanAddr, "@")
	if len(parts) == 2 {
		domain := parts[1]
		if s.userMgr != nil {
			if ownerID, err := s.userMgr.GetUserIDByDomain(domain); err == nil && ownerID == u.ID {
				return true
			}
		}
	}
	return false
}

func (s *APIServer) lookupMailboxAnywhere(targetDB *db.DB, address string) (*models.Mailbox, error) {
	clean := strings.ToLower(strings.TrimSpace(address))
	if targetDB != nil {
		if mb, err := targetDB.GetMailbox(clean); err == nil && mb != nil {
			return mb, nil
		}
	}
	if s.db != nil && s.db != targetDB {
		if mb, err := s.db.GetMailbox(clean); err == nil && mb != nil {
			return mb, nil
		}
	}
	if s.userMgr != nil {
		parts := strings.Split(clean, "@")
		if len(parts) == 2 {
			if uid, err := s.userMgr.GetUserIDByDomain(parts[1]); err == nil && uid != "" {
				if udb, err := s.userMgr.GetUserDB(uid); err == nil && udb != nil && udb != targetDB && udb != s.db {
					if mb, err := udb.GetMailbox(clean); err == nil && mb != nil {
						return mb, nil
					}
				}
			}
		}
	}
	return nil, fmt.Errorf("mailbox %q not found", address)
}

func formatBytes(b int64) string {
	if b <= 0 {
		return "unlimited"
	}
	if b >= 1024*1024*1024 {
		return fmt.Sprintf("%g GB", float64(b)/(1024*1024*1024))
	}
	return fmt.Sprintf("%d MB", b/(1024*1024))
}

func (s *APIServer) handleLiveWS(w http.ResponseWriter, r *http.Request) {
	token := extractBearerToken(r)

	if token != "" {
		if s.userMgr != nil && !strings.HasPrefix(token, "mg_mbx_") {
			if u, err := s.userMgr.AuthenticateToken(token); err == nil && u != nil {
				if s.isAdmin(u) {
					s.liveHub.HandleWSWithFilter(w, r, nil)
					return
				}
				userID := u.ID
				s.liveHub.HandleWSWithFilter(w, r, func(event *models.LiveEvent) bool {
					if event.Address == "" {
						return true
					}
					parts := strings.Split(event.Address, "@")
					domain := parts[len(parts)-1]
					ownerID, err := s.userMgr.GetUserIDByDomain(domain)
					return err == nil && ownerID == userID
				})
				return
			}
		}

		mbxAddr := s.authenticateMailboxToken(token)
		if mbxAddr != "" {
			cleanMbx := strings.ToLower(mbxAddr)
			s.liveHub.HandleWSWithFilter(w, r, func(event *models.LiveEvent) bool {
				return strings.ToLower(event.Address) == cleanMbx
			})
			return
		}
	}

	http.Error(w, "Unauthorized: valid user or mailbox token required for live stream", http.StatusUnauthorized)
}

func (s *APIServer) resolveUser(r *http.Request) *usermanager.User {
	if s.userMgr == nil {

		return nil
	}

	token := extractBearerToken(r)
	if token != "" && !strings.HasPrefix(token, "mg_mbx_") {
		if u, err := s.userMgr.AuthenticateToken(token); err == nil && u != nil {
			return u
		}
	}

	return nil
}

func (s *APIServer) resolveDB(r *http.Request) (*db.DB, *storage.Storage, *usermanager.User) {
	u := s.resolveUser(r)
	if u != nil && s.userMgr != nil {
		udb, err := s.userMgr.GetUserDB(u.ID)
		ustore, err2 := s.userMgr.GetUserStorage(u.ID)
		if err == nil && err2 == nil {
			return udb, ustore, u
		}
	}
	return s.db, s.storage, u
}

func (s *APIServer) resolveDBForAddress(r *http.Request, rawAddress string) (*db.DB, *storage.Storage, *usermanager.User) {
	if s.userMgr != nil {
		clean := strings.Split(rawAddress, "/")[0]
		parts := strings.Split(clean, "@")
		if len(parts) == 2 {
			domain := strings.ToLower(strings.TrimSpace(parts[1]))
			if uid, err := s.userMgr.GetUserIDByDomain(domain); err == nil && uid != "" {
				udb, err1 := s.userMgr.GetUserDB(uid)
				ustore, err2 := s.userMgr.GetUserStorage(uid)
				if err1 == nil && err2 == nil {
					user, _ := s.userMgr.GetUserByID(uid)
					return udb, ustore, user
				}
			}
		}
	}
	return s.resolveDB(r)
}

func resolveRecordStatus(r models.DNSRecord, d *models.Domain) string {
	if r.Status == "verified" {
		return "ok"
	}
	if d != nil {
		var st string
		switch {
		case strings.HasPrefix(r.Purpose, "SPF") || (r.Type == "TXT" && strings.HasPrefix(r.Value, "v=spf1")):
			st = d.SPFStatus
		case strings.HasPrefix(r.Purpose, "DKIM") || strings.Contains(r.Name, "_domainkey"):
			st = d.DKIMStatus
		case strings.HasPrefix(r.Purpose, "DMARC") || strings.Contains(r.Name, "_dmarc"):
			st = d.DMARCStatus
		case strings.HasPrefix(r.Purpose, "MX") || r.Type == "MX":
			st = d.MXStatus
		}
		if st == "verified" || (d.IsVerified && (st == "" || st == "ok")) {
			return "ok"
		}
		if st == "failed" || st == "fail" {
			return "fail"
		}
		if st == "pending" {
			return "pending"
		}
	}
	if r.Status == "failed" || r.Status == "fail" {
		return "fail"
	}
	return "pending"
}

func (s *APIServer) toFrontDomain(d *models.Domain) map[string]interface{} {
	st := "pending"
	if d.IsActive && d.IsVerified {
		st = "verified"
	}
	recs := s.dnsChecker.GenerateDNSRecords(d.Name, d.Selector, d.DKIMPublicKeyB64, s.serverHost)
	var dnsList []map[string]string
	for _, r := range recs {
		rst := resolveRecordStatus(r, d)
		errStr := ""
		if rst != "ok" {
			switch {
			case strings.HasPrefix(r.Purpose, "SPF") || (r.Type == "TXT" && strings.HasPrefix(r.Value, "v=spf1")):
				errStr = "SPF record not verified on domain DNS."
			case strings.HasPrefix(r.Purpose, "DKIM") || strings.Contains(r.Name, "_domainkey"):
				errStr = "DKIM public key not verified for selector '" + d.Selector + "'."
			case strings.HasPrefix(r.Purpose, "DMARC") || strings.Contains(r.Name, "_dmarc"):
				errStr = "DMARC policy not verified on domain DNS."
			case strings.HasPrefix(r.Purpose, "MX") || r.Type == "MX":
				errStr = "MX record not pointing to server host (" + s.serverHost + ")."
			}
		}
		item := map[string]string{
			"kind":   r.Type,
			"host":   r.Name,
			"value":  r.Value,
			"status": rst,
		}
		if errStr != "" {
			item["error"] = errStr
		}
		dnsList = append(dnsList, item)
	}
	addedAt := time.Now().Format("2006-01-02")
	if d.CreatedAt > 0 {
		addedAt = time.Unix(d.CreatedAt, 0).Format("2006-01-02")
	}
	var lastCheck interface{} = nil
	if d.LastDNSCheckAt > 0 {
		lastCheck = d.LastDNSCheckAt * 1000
	}
	return map[string]interface{}{
		"name":      d.Name,
		"status":    st,
		"addedAt":   addedAt,
		"mxMode":    "default",
		"mxServers": []interface{}{},
		"dns":       dnsList,
		"lastCheck": lastCheck,
	}
}

func (s *APIServer) handleAuthSignup(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	ip := httputil.ClientIP(r)
	if !s.signupLimiter.Allow(ip) {
		http.Error(w, "Too many sign up attempts. Please wait a minute.", http.StatusTooManyRequests)
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON body", http.StatusBadRequest)
		return
	}

	if s.userMgr == nil {
		http.Error(w, "User manager not initialized", http.StatusInternalServerError)
		return
	}

	u, err := s.userMgr.Signup(req.Email, req.Password)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	isAdmin := s.isAdmin(u)
	w.Header().Set("Content-Type", "application/json")

	if u.Status == "pending" {
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"user": map[string]interface{}{
				"id":      u.ID,
				"email":   u.Email,
				"plan":    u.Plan,
				"status":  u.Status,
				"isAdmin": false,
				"mode":    s.mode,
			},
			"pendingApproval": true,
			"message":         "Registration successful! Your account is pending administrator approval before you can access the dashboard.",
		})
		return
	}

	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"user": map[string]interface{}{
			"id":      u.ID,
			"email":   u.Email,
			"plan":    u.Plan,
			"status":  u.Status,
			"isAdmin": isAdmin,
			"mode":    s.mode,
		},
		"token":           u.Token,
		"pendingApproval": false,
	})
}

func (s *APIServer) handleAuthLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	ip := httputil.ClientIP(r)
	if !s.authLimiter.Allow(ip) {
		http.Error(w, "Too many login attempts. Please wait a minute.", http.StatusTooManyRequests)
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON body", http.StatusBadRequest)
		return
	}

	if s.userMgr == nil {
		http.Error(w, "User manager not initialized", http.StatusInternalServerError)
		return
	}

	u, err := s.userMgr.Login(req.Email, req.Password)
	if err != nil {
		errMsg := strings.ToLower(err.Error())
		if strings.Contains(errMsg, "approval") || strings.Contains(errMsg, "pending") || strings.Contains(errMsg, "blocked") || strings.Contains(errMsg, "suspended") {
			http.Error(w, err.Error(), http.StatusForbidden)
			return
		}
		http.Error(w, err.Error(), http.StatusUnauthorized)
		return
	}

	isAdmin := s.isAdmin(u)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"user": map[string]interface{}{
			"id":      u.ID,
			"email":   u.Email,
			"plan":    u.Plan,
			"status":  u.Status,
			"isAdmin": isAdmin,
			"mode":    s.mode,
		},
		"token": u.Token,
	})
}

func (s *APIServer) handleAuthMe(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	u := s.resolveUser(r)
	if u == nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	isAdmin := s.isAdmin(u)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"user": map[string]interface{}{
			"id":      u.ID,
			"email":   u.Email,
			"plan":    u.Plan,
			"status":  u.Status,
			"isAdmin": isAdmin,
			"mode":    s.mode,
		},
	})
}

func (s *APIServer) handleAdminUsers(w http.ResponseWriter, r *http.Request) {
	u := s.resolveUser(r)
	if !s.isAdmin(u) {
		http.Error(w, "Forbidden: administrator privileges required", http.StatusForbidden)
		return
	}

	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if s.userMgr == nil {
		http.Error(w, "User manager not initialized", http.StatusInternalServerError)
		return
	}

	users, err := s.userMgr.ListUsers()
	if err != nil {
		http.Error(w, "Failed to list users: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"users": users,
		"mode":  s.mode,
	})
}

func (s *APIServer) handleAdminUserAction(w http.ResponseWriter, r *http.Request) {
	u := s.resolveUser(r)
	if !s.isAdmin(u) {
		http.Error(w, "Forbidden: administrator privileges required", http.StatusForbidden)
		return
	}

	subPath := strings.TrimPrefix(r.URL.Path, "/api/admin/users/")
	subPath = strings.Trim(subPath, "/")
	if subPath == "" {
		if r.Method == http.MethodGet {
			s.handleAdminUsers(w, r)
			return
		}
		http.Error(w, "User ID required", http.StatusBadRequest)
		return
	}
	parts := strings.Split(subPath, "/")
	targetUserID := parts[0]

	if len(parts) >= 2 && parts[1] == "status" {
		if r.Method != http.MethodPost && r.Method != http.MethodPatch {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		var req struct {
			Status string `json:"status"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "Invalid JSON body", http.StatusBadRequest)
			return
		}

		if err := s.userMgr.SetUserStatus(targetUserID, req.Status); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		updatedUser, _ := s.userMgr.GetUserByID(targetUserID)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"success": true,
			"user":    updatedUser,
		})
		return
	}

	if r.Method == http.MethodDelete {
		if err := s.userMgr.DeleteUser(targetUserID); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"success": true,
		})
		return
	}

	http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
}

func (s *APIServer) handleAuthLogout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	authHeader := r.Header.Get("Authorization")
	token := strings.TrimPrefix(authHeader, "Bearer ")
	if token != "" && s.userMgr != nil {
		_ = s.userMgr.Logout(token)
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
	})
}

func (s *APIServer) handleUserExport(w http.ResponseWriter, r *http.Request) {
	u := s.resolveUser(r)
	if u == nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	if s.userMgr == nil {
		http.Error(w, "User manager not initialized", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=mailergo-export-%s.zip", u.ID))

	if err := s.userMgr.ExportUserDataZip(u.ID, w); err != nil {
		log.Printf("[EXPORT ERROR] Failed to stream user %s data zip: %v", u.ID, err)
	}
}
