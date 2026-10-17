package smtpserver

import (
	"crypto/tls"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"time"

	"github.com/emersion/go-smtp"
	"mailer-go/backend/shared/crypto"
	"mailer-go/backend/shared/emailparser"
	"mailer-go/backend/shared/models"
	"mailer-go/backend/smtp/pkg/domains"
	"mailer-go/backend/smtp/pkg/hub"
	"mailer-go/backend/smtp/pkg/verifier"
)

type SMTPServer struct {
	server *smtp.Server
}

type Backend struct {
	hub             *hub.WSHub
	domainMgr       *domains.DomainManager
	verifier        *verifier.Verifier
	debug           bool
	maxMessageBytes int64
}

func (b *Backend) NewSession(c *smtp.Conn) (smtp.Session, error) {
	remoteIP := ""
	if c.Conn() != nil && c.Conn().RemoteAddr() != nil {
		if tcpAddr, ok := c.Conn().RemoteAddr().(*net.TCPAddr); ok {
			remoteIP = tcpAddr.IP.String()
		} else {
			host, _, err := net.SplitHostPort(c.Conn().RemoteAddr().String())
			if err == nil {
				remoteIP = host
			}
		}
	}
	tlsUsed := false
	if _, ok := c.TLSConnectionState(); ok {
		tlsUsed = true
	}

	return &Session{
		hub:             b.hub,
		domainMgr:       b.domainMgr,
		verifier:        b.verifier,
		clientIP:        remoteIP,
		helo:            c.Hostname(),
		tls:             tlsUsed,
		debug:           b.debug,
		maxMessageBytes: b.maxMessageBytes,
	}, nil
}

type Session struct {
	hub             *hub.WSHub
	domainMgr       *domains.DomainManager
	verifier        *verifier.Verifier
	clientIP        string
	helo            string
	tls             bool
	debug           bool
	from            string
	to              []string
	maxMessageBytes int64
}

func (s *Session) Mail(from string, opts *smtp.MailOptions) error {
	s.from = from
	if s.debug {
		log.Printf("[SMTP-DEBUG] <<< MAIL FROM: <%s>", from)
	}
	return nil
}

func (s *Session) Rcpt(to string, opts *smtp.RcptOptions) error {
	if s.debug {
		log.Printf("[SMTP-DEBUG] <<< RCPT TO: <%s>", to)
	}
	allowed, domain := s.domainMgr.IsRecipientAllowed(to)
	if !allowed {
		log.Printf("[SECURITY] Rejected inbound mail to <%s>: Domain %q is not authorized on this server (anti-relay protection). Allowed domains: %v",
			to, domain, s.domainMgr.ListDomains())
		return &smtp.SMTPError{
			Code:         550,
			EnhancedCode: smtp.EnhancedCode{5, 1, 1},
			Message:      "Relay access denied: domain not hosted on this server",
		}
	}

	if s.debug {
		log.Printf("[SMTP-DEBUG] >>> Accepted recipient <%s> for domain %q", to, domain)
	}
	s.to = append(s.to, to)
	return nil
}

func (s *Session) Data(r io.Reader) error {
	if s.debug {
		log.Printf("[SMTP-DEBUG] <<< Entering DATA phase for recipients: %v", s.to)
	}
	if len(s.to) == 0 {
		return &smtp.SMTPError{
			Code:         503,
			EnhancedCode: smtp.EnhancedCode{5, 5, 1},
			Message:      "No valid recipients specified",
		}
	}

	limit := s.maxMessageBytes
	if limit <= 0 {
		limit = 25 * 1024 * 1024
	}
	rawBytes, err := io.ReadAll(io.LimitReader(r, limit+1024*1024))
	if err != nil {
		log.Printf("[SMTP] Error reading DATA stream: %v", err)
		return err
	}

	if int64(len(rawBytes)) > limit {
		log.Printf("[SMTP WARNING] Dropping incoming message: size %d exceeds limit %d", len(rawBytes), limit)
		return &smtp.SMTPError{
			Code:         552,
			EnhancedCode: smtp.EnhancedCode{5, 3, 4},
			Message:      "Message size exceeds maximum allowed limit",
		}
	}

	rawContent := string(rawBytes)
	parsed := emailparser.ParseEmail(rawBytes)

	subject := parsed.Subject
	if subject == "" {
		subject = "(No Subject)"
	}

	verification := s.verifier.Verify(rawBytes, s.from, s.clientIP, s.helo, s.tls)

	mailID := crypto.GenerateID("mail")
	mailMsg := &models.MailMessage{
		ID:           mailID,
		From:         s.from,
		To:           s.to,
		Subject:      subject,
		Headers:      parsed.Headers,
		Body:         parsed.TextBody,
		BodyHTML:     parsed.HTMLBody,
		Attachments:  parsed.Attachments,
		Raw:          rawContent,
		SizeBytes:    int64(len(rawBytes)),
		Verification: verification,
		CreatedAt:    time.Now(),
	}

	badge := "[UNVERIFIED]"
	if verification.IsVerified {
		badge = "[VERIFIED]"
	}

	log.Printf("[SMTP] Received mail %s: From=<%s> To=%v Subject=%q [%s] (%d bytes)",
		mailID, s.from, s.to, subject, badge, len(rawBytes))

	if s.debug {
		log.Println("================== [INCOMING EMAIL DEBUG] ==================")
		log.Printf("ID:           %s", mailID)
		log.Printf("Security:     %s [%s]", badge, verification.Summary)
		log.Printf("Checks:       SPF=%s | DKIM=%s | DMARC=%s | TLS=%t",
			verification.SPF, verification.DKIM, verification.DMARC, verification.TLS)
		previewLen := 300
		if len(parsed.TextBody) < previewLen {
			previewLen = len(parsed.TextBody)
		}
		log.Printf("Body Preview:\n%s", parsed.TextBody[:previewLen])
		log.Println("============================================================")
	}

	if err := s.hub.DispatchIncomingMail(mailMsg); err != nil {
		log.Printf("[SMTP ALERT] Spool reject for mail %s: %v", mailID, err)
		return &smtp.SMTPError{
			Code:         452,
			EnhancedCode: smtp.EnhancedCode{4, 4, 5},
			Message:      "Insufficient system storage: spool quota reached, please retry later",
		}
	}

	return nil
}

func (s *Session) Reset() {
	s.from = ""
	s.to = nil
}

func (s *Session) Logout() error {
	if s.debug {
		log.Println("[SMTP-DEBUG] Client session closed (QUIT / Logout).")
	}
	return nil
}

func NewSMTPServer(
	addr, domain string,
	wsHub *hub.WSHub,
	domainMgr *domains.DomainManager,
	debug bool,
	maxMessageMB int64,
	maxRecipients int,
	readTimeoutSec int,
	writeTimeoutSec int,
	tlsCertFile string,
	tlsKeyFile string,
) *SMTPServer {
	if maxMessageMB <= 0 {
		maxMessageMB = 25
	}
	if maxRecipients <= 0 {
		maxRecipients = 50
	}
	if readTimeoutSec <= 0 {
		readTimeoutSec = 30
	}
	if writeTimeoutSec <= 0 {
		writeTimeoutSec = 30
	}

	maxBytes := maxMessageMB * 1024 * 1024
	v := verifier.NewVerifier()
	s := smtp.NewServer(&Backend{
		hub:             wsHub,
		domainMgr:       domainMgr,
		verifier:        v,
		debug:           debug,
		maxMessageBytes: maxBytes,
	})
	s.Addr = addr
	s.Domain = domain
	s.ReadTimeout = time.Duration(readTimeoutSec) * time.Second
	s.WriteTimeout = time.Duration(writeTimeoutSec) * time.Second
	s.MaxMessageBytes = maxBytes
	s.MaxRecipients = maxRecipients
	s.MaxLineLength = 4096

	s.AllowInsecureAuth = false

	if tlsCertFile == "" && tlsKeyFile == "" && domain != "" && crypto.ValidateDomain(domain) {
		candidateCert := fmt.Sprintf("/etc/letsencrypt/live/%s/fullchain.pem", domain)
		candidateKey := fmt.Sprintf("/etc/letsencrypt/live/%s/privkey.pem", domain)
		if _, err1 := os.Stat(candidateCert); err1 == nil {
			if _, err2 := os.Stat(candidateKey); err2 == nil {
				tlsCertFile = candidateCert
				tlsKeyFile = candidateKey
			}
		}
	}

	if tlsCertFile != "" && tlsKeyFile != "" {
		cert, err := tls.LoadX509KeyPair(tlsCertFile, tlsKeyFile)
		if err != nil {
			log.Printf("[SMTP TLS WARNING] Failed to load TLS certificate (%s, %s): %v. Server will operate without STARTTLS.", tlsCertFile, tlsKeyFile, err)
		} else {
			s.TLSConfig = &tls.Config{
				Certificates: []tls.Certificate{cert},
				MinVersion:   tls.VersionTLS12,
			}
			log.Printf("[SMTP TLS] Inbound STARTTLS enabled (TLS 1.2+) using cert %s for domain %s", tlsCertFile, domain)
		}
	} else {
		log.Printf("[SMTP TLS NOTICE] No TLS certificates provided. Inbound STARTTLS is disabled.")
	}

	if debug {
		s.Debug = os.Stdout
		log.Println("[SMTP] Full wire debug logging enabled (os.Stdout)")
	}

	return &SMTPServer{server: s}
}

func (s *SMTPServer) ListenAndServe() error {
	log.Printf("[SMTP] SMTP Server listening on %s (Domain: %s)", s.server.Addr, s.server.Domain)
	return s.server.ListenAndServe()
}

func (s *SMTPServer) Close() error {
	return s.server.Close()
}
