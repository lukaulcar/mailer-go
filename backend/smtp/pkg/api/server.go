package api

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	"mailer-go/backend/shared/crypto"
	"mailer-go/backend/shared/httputil"
	"mailer-go/backend/shared/models"
	"mailer-go/backend/smtp/pkg/config"
	"mailer-go/backend/smtp/pkg/domains"
	"mailer-go/backend/smtp/pkg/hub"
	"mailer-go/backend/smtp/pkg/outbound"
	"mailer-go/backend/smtp/pkg/spool"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {

		origin := r.Header.Get("Origin")
		if origin == "" {
			return true
		}
		host := r.Host
		if u, err := url.Parse(origin); err == nil && u.Host == host {
			return true
		}
		return false
	},
	ReadBufferSize:  1024 * 64,
	WriteBufferSize: 1024 * 64,
}

type APIServer struct {
	cfg         *config.Config
	hub         *hub.WSHub
	spool       *spool.SpoolManager
	sender      *outbound.Sender
	encryptor   *crypto.Encryptor
	domainMgr   *domains.DomainManager
	startTime   time.Time
	authLimiter *ipLimiter
	sendLimiter *ipLimiter
}

func NewAPIServer(
	cfg *config.Config,
	wsHub *hub.WSHub,
	spoolMgr *spool.SpoolManager,
	sender *outbound.Sender,
	encryptor *crypto.Encryptor,
	domainMgr *domains.DomainManager,
) *APIServer {
	return &APIServer{
		cfg:         cfg,
		hub:         wsHub,
		spool:       spoolMgr,
		sender:      sender,
		encryptor:   encryptor,
		domainMgr:   domainMgr,
		startTime:   time.Now(),
		authLimiter: newIPLimiter(20, time.Minute),
		sendLimiter: newIPLimiter(60, time.Minute),
	}
}

func (s *APIServer) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/ws", s.handleWebSocket)
	mux.HandleFunc("/api/auth", s.handleAuth)
	mux.HandleFunc("/api/send", s.handleSend)
	mux.HandleFunc("/api/status", s.handleStatus)
	mux.HandleFunc("/api/domains", s.handleDomains)
	mux.HandleFunc("/api/domains/sync", s.handleDomainsSync)
}

func (s *APIServer) authenticate(r *http.Request) bool {
	token := ""
	authHeader := r.Header.Get("Authorization")
	if strings.HasPrefix(authHeader, "Bearer ") {
		token = strings.TrimPrefix(authHeader, "Bearer ")
	} else if r.Method == http.MethodGet && r.URL.Path == "/ws" {

		token = r.URL.Query().Get("token")
	}

	if token == "" || s.cfg.AuthToken == "" {
		return false
	}

	return secureEqual(token, s.cfg.AuthToken)
}

func secureEqual(a, b string) bool {
	ah := sha256.Sum256([]byte(a))
	bh := sha256.Sum256([]byte(b))
	return subtle.ConstantTimeCompare(ah[:], bh[:]) == 1
}

func (s *APIServer) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	if !s.authenticate(r) {
		http.Error(w, "Unauthorized: invalid authentication token", http.StatusUnauthorized)
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[API] WebSocket upgrade failed: %v", err)
		return
	}

	s.hub.Register(conn)

	go func() {
		defer s.hub.UnregisterConn(conn)
		conn.SetReadLimit(65536)
		_ = conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		conn.SetPongHandler(func(string) error {
			_ = conn.SetReadDeadline(time.Now().Add(60 * time.Second))
			return nil
		})
		conn.SetPingHandler(func(appData string) error {
			_ = conn.SetReadDeadline(time.Now().Add(60 * time.Second))
			return conn.WriteControl(websocket.PongMessage, []byte(appData), time.Now().Add(5*time.Second))
		})
		for {
			_, _, err := conn.ReadMessage()
			if err != nil {
				break
			}
			_ = conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		}
	}()
}

func (s *APIServer) handleAuth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if !s.authLimiter.allow(httputil.ClientIP(r)) {
		http.Error(w, "Too many authentication attempts", http.StatusTooManyRequests)
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, 1024*1024)
	var req struct {
		Token string `json:"token"`
	}

	if s.cfg.AuthToken == "" {
		http.Error(w, "Server configuration error: AUTH_TOKEN not set", http.StatusInternalServerError)
		return
	}

	authenticated := false
	if err := json.NewDecoder(r.Body).Decode(&req); err == nil && req.Token != "" {
		if secureEqual(req.Token, s.cfg.AuthToken) {
			authenticated = true
		}
	}
	if !authenticated && s.authenticate(r) {
		authenticated = true
	}

	if !authenticated {
		http.Error(w, "Invalid credentials", http.StatusUnauthorized)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"authenticated": true,
		"server_time":   time.Now().UTC(),
		"encryption":    "AES-256-GCM",
	})
}

func (s *APIServer) handleSend(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if !s.authenticate(r) {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	if !s.sendLimiter.allow(httputil.ClientIP(r)) {
		http.Error(w, "Too many send requests", http.StatusTooManyRequests)
		return
	}

	limitMB := s.cfg.OutboundBodyLimitMB
	if limitMB <= 0 {
		limitMB = 64
	}
	r.Body = http.MaxBytesReader(w, r.Body, limitMB*1024*1024)
	bodyBytes, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "Failed to read request body: payload too large", http.StatusRequestEntityTooLarge)
		return
	}

	var envelope models.EncryptedEnvelope
	if err := json.Unmarshal(bodyBytes, &envelope); err != nil {
		http.Error(w, "Invalid JSON envelope", http.StatusBadRequest)
		return
	}

	decryptedBytes, err := s.encryptor.Decrypt(envelope.Payload)
	if err != nil {
		log.Printf("[API] Failed to decrypt outbound mail envelope: %v", err)
		http.Error(w, "Decryption error: invalid AES payload", http.StatusBadRequest)
		return
	}

	var sendReq models.OutboundSendRequest
	if err := json.Unmarshal(decryptedBytes, &sendReq); err != nil {
		http.Error(w, "Invalid outbound send request payload", http.StatusBadRequest)
		return
	}

	result, err := s.sender.Send(&sendReq)
	if err != nil {
		log.Printf("[API] Outbound delivery failed: %v", err)
		http.Error(w, "Failed to broadcast mail", http.StatusInternalServerError)
		return
	}

	resp := models.OutboundSendResponse{
		Success:       true,
		Message:       "Outbound mail queued and broadcasted successfully",
		FailedDomains: result.FailedDomains,
	}
	status := http.StatusOK
	if len(result.FailedDomains) > 0 {

		resp.Message = "Outbound mail partially delivered: some domains failed"
		status = http.StatusMultiStatus
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(resp)
}

func (s *APIServer) handleStatus(w http.ResponseWriter, r *http.Request) {
	if !s.authenticate(r) {
		if !s.authLimiter.allow(httputil.ClientIP(r)) {
			http.Error(w, "Too many failed attempts", http.StatusTooManyRequests)
			return
		}
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	stats := s.spool.GetStats()
	domainsList := s.domainMgr.ListDomains()
	status := map[string]interface{}{
		"status":          "running",
		"server_live_ws":  s.hub.IsConnected(),
		"uptime_seconds":  int(time.Since(s.startTime).Seconds()),
		"spool_metrics":   stats,
		"allowed_domains": domainsList,
		"domains_count":   len(domainsList),
		"max_ram_mb":      s.cfg.MaxRAMMB,
		"smtp_port":       s.cfg.SMTPPort,
		"http_port":       s.cfg.HTTPPort,
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(status)
}

func (s *APIServer) handleDomains(w http.ResponseWriter, r *http.Request) {
	if !s.authenticate(r) {
		if !s.authLimiter.allow(httputil.ClientIP(r)) {
			http.Error(w, "Too many failed attempts", http.StatusTooManyRequests)
			return
		}
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	w.Header().Set("Content-Type", "application/json")

	switch r.Method {
	case http.MethodGet:
		domains := s.domainMgr.ListDomains()
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"domains": domains,
			"total":   len(domains),
			"source":  "local_sqlite_cache",
		})
		return

	case http.MethodPost:
		r.Body = http.MaxBytesReader(w, r.Body, 1024*1024)
		var req struct {
			Domain        string `json:"domain"`
			Selector      string `json:"selector"`
			PrivateKeyPEM string `json:"private_key_pem"`
			PublicKeyB64  string `json:"public_key_b64"`
			IsActive      *bool  `json:"is_active"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "Invalid JSON body", http.StatusBadRequest)
			return
		}
		cleanDomain := strings.ToLower(strings.TrimSpace(req.Domain))
		if cleanDomain == "" {
			http.Error(w, "domain is required", http.StatusBadRequest)
			return
		}
		if !crypto.ValidateDomain(cleanDomain) {
			http.Error(w, "invalid domain name", http.StatusBadRequest)
			return
		}
		if req.Selector == "" {
			req.Selector = "mail"
		}
		if !crypto.ValidateDomain(req.Selector) {
			http.Error(w, "invalid DKIM selector", http.StatusBadRequest)
			return
		}
		active := true
		if req.IsActive != nil {
			active = *req.IsActive
		}
		sd := models.SyncDomain{
			Domain:        cleanDomain,
			Selector:      req.Selector,
			PrivateKeyPEM: req.PrivateKeyPEM,
			PublicKeyB64:  req.PublicKeyB64,
			IsActive:      active,
			UpdatedAt:     time.Now().Unix(),
		}
		if err := s.domainMgr.UpsertDomain(sd); err != nil {
			http.Error(w, "Failed to upsert domain: "+err.Error(), http.StatusInternalServerError)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"success":   true,
			"message":   "Domain upserted into local cache",
			"domain":    cleanDomain,
			"is_active": active,
		})
		return

	case http.MethodDelete:
		domain := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("domain")))
		if domain == "" || !crypto.ValidateDomain(domain) {
			http.Error(w, "valid domain query param is required", http.StatusBadRequest)
			return
		}
		if err := s.domainMgr.DeleteDomain(domain); err != nil {
			http.Error(w, "Failed to delete domain: "+err.Error(), http.StatusInternalServerError)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"success": true,
			"domain":  domain,
		})
		return

	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *APIServer) handleDomainsSync(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if !s.authenticate(r) {
		if !s.authLimiter.allow(httputil.ClientIP(r)) {
			http.Error(w, "Too many failed attempts", http.StatusTooManyRequests)
			return
		}
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, 16*1024*1024)
	var req models.SyncStateResponse
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON payload: "+err.Error(), http.StatusBadRequest)
		return
	}

	if err := s.domainMgr.UpdateFromSync(req.Domains, req.Aliases); err != nil {
		log.Printf("[API ERROR] Failed to apply domain sync: %v", err)
		http.Error(w, "Failed to apply domain sync: "+err.Error(), http.StatusInternalServerError)
		return
	}

	log.Printf("[API DOMAIN SYNC] Successfully synced %d domain(s) and %d alias(es) into local SQLite cache",
		len(req.Domains), len(req.Aliases))

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"success":        true,
		"synced_domains": len(req.Domains),
		"synced_aliases": len(req.Aliases),
		"server_time":    time.Now().Unix(),
	})
}
