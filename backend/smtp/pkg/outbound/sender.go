package outbound

import (
	"bytes"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"log"
	"mime"
	"net"
	"net/mail"
	netSMTP "net/smtp"
	"path/filepath"
	"strings"
	"time"

	"mailer-go/backend/shared/mimeutil"
	"mailer-go/backend/shared/models"
	"mailer-go/backend/smtp/pkg/domains"

	"github.com/emersion/go-msgauth/dkim"
)

type Sender struct {
	domainMgr      *domains.DomainManager
	serverHostname string
	dialTimeout    time.Duration
	smtpPort       string

	simulateReservedDomains bool
}

func NewSender(domainMgr *domains.DomainManager, serverHostname string, dialTimeoutSeconds int, smtpPort string, simulateReservedDomains bool) *Sender {
	if dialTimeoutSeconds <= 0 {
		dialTimeoutSeconds = 10
	}
	if smtpPort == "" {
		smtpPort = "25"
	}
	return &Sender{
		domainMgr:               domainMgr,
		serverHostname:          serverHostname,
		dialTimeout:             time.Duration(dialTimeoutSeconds) * time.Second,
		smtpPort:                smtpPort,
		simulateReservedDomains: simulateReservedDomains,
	}
}

type SendResult struct {
	DeliveredDomains []string
	FailedDomains    map[string]string
}

func (s *Sender) Send(req *models.OutboundSendRequest) (*SendResult, error) {
	if len(req.To) == 0 {
		return nil, fmt.Errorf("no recipients specified")
	}

	log.Printf("[OUTBOUND] Direct dispatching mail from %s to %v (Subject: %s)", req.From, req.To, req.Subject)

	domainMap := make(map[string][]string)
	for _, to := range req.To {
		domain := domains.ExtractDomain(to)
		if domain != "" {
			domainMap[domain] = append(domainMap[domain], to)
		} else {
			log.Printf("[OUTBOUND WARNING] Could not extract valid domain from recipient: %s", to)
		}
	}

	if len(domainMap) == 0 {
		return nil, fmt.Errorf("no valid recipient domains found")
	}

	result := &SendResult{FailedDomains: make(map[string]string)}
	var deliveryErrors []string
	for domain, recipients := range domainMap {
		if err := s.deliverToDomain(domain, req.From, recipients, req); err != nil {
			log.Printf("[OUTBOUND] Warning: failed delivery to domain %s: %v", domain, err)
			result.FailedDomains[domain] = err.Error()
			deliveryErrors = append(deliveryErrors, fmt.Sprintf("%s: %v", domain, err))
		} else {
			result.DeliveredDomains = append(result.DeliveredDomains, domain)
		}
	}

	if len(result.DeliveredDomains) == 0 {
		return result, fmt.Errorf("outbound delivery failed for all domains: %s", strings.Join(deliveryErrors, "; "))
	}

	return result, nil
}

func (s *Sender) deliverToDomain(domain, from string, recipients []string, req *models.OutboundSendRequest) error {
	raw := buildRawMessage(req)

	senderDomain := domains.ExtractDomain(from)
	if s.domainMgr != nil && senderDomain != "" {
		if privKey, selector, ok := s.domainMgr.GetSigningKey(senderDomain); ok && privKey != nil {
			signed, err := signDKIM(raw, senderDomain, selector, privKey)
			if err == nil {
				raw = signed
				log.Printf("[OUTBOUND] Successfully DKIM-signed outbound email for domain %s (selector: %s)", senderDomain, selector)
			} else {
				log.Printf("[OUTBOUND] Warning: DKIM signing failed for domain %s: %v", senderDomain, err)
			}
		}
	}

	if s.simulateReservedDomains && isReservedTestDomain(domain) {
		log.Printf("[OUTBOUND][WARN] SIMULATED delivery for reserved test domain %s (recipients: %v). No mail was actually sent.", domain, recipients)
		return nil
	}

	targets := s.resolveMxTargets(domain)
	if len(targets) == 0 {

		return fmt.Errorf("no safe MX hosts for domain %s", domain)
	}

	var lastErr error
	for _, t := range targets {
		log.Printf("[OUTBOUND] Connecting to MX %s (%s) for domain %s...", t.host, t.ip, domain)

		err := s.dialAndDeliver(t.ip, t.host, from, recipients, raw)
		if err == nil {
			log.Printf("[OUTBOUND] Successfully delivered to MX %s (%s) for recipients %v", t.host, t.ip, recipients)
			return nil
		}

		lastErr = err
		log.Printf("[OUTBOUND WARNING] Failed delivery to MX %s (%s): %v. Trying next MX if available...", t.host, t.ip, err)
	}

	return fmt.Errorf("delivery failed for domain %s on all MX hosts: %w", domain, lastErr)
}

type mxTarget struct {
	host string
	ip   net.IP
}

func (s *Sender) resolveMxTargets(domain string) []mxTarget {
	mxs, err := net.LookupMX(domain)
	if err != nil || len(mxs) == 0 {
		return nil
	}

	var targets []mxTarget
	for _, mx := range mxs {
		host := strings.ToLower(strings.TrimSpace(strings.TrimSuffix(mx.Host, ".")))
		if host == "" || isReservedMXHostname(host) {
			continue
		}

		ips, err := net.LookupIP(host)
		if err != nil {
			continue
		}

		blocked := false
		var v4 []net.IP
		for _, ip := range ips {
			ip4 := ip.To4()
			if ip4 == nil {
				continue
			}
			if isBlockedIP(ip4) {
				blocked = true
				break
			}
			v4 = append(v4, ip4)
		}
		if blocked || len(v4) == 0 {
			continue
		}

		for _, ip4 := range v4 {
			targets = append(targets, mxTarget{host: host, ip: ip4})
		}
	}

	return targets
}

func isReservedMXHostname(host string) bool {
	h := strings.ToLower(strings.TrimSpace(strings.TrimSuffix(host, ".")))
	if h == "" || h == "localhost" {
		return true
	}
	if strings.HasSuffix(h, ".local") || strings.HasSuffix(h, ".test") || strings.HasSuffix(h, ".example") ||
		strings.HasSuffix(h, ".invalid") || strings.HasSuffix(h, ".localhost") {
		return true
	}
	if net.ParseIP(strings.Trim(h, "[]")) != nil {
		return true
	}
	return false
}

func isBlockedIP(ip net.IP) bool {
	if ip == nil {
		return true
	}
	return !ip.IsGlobalUnicast() ||
		ip.IsPrivate() ||
		ip.IsLoopback() ||
		ip.IsLinkLocalUnicast() ||
		ip.IsMulticast() ||
		ip.IsUnspecified()
}

func isReservedTestDomain(domain string) bool {
	d := strings.ToLower(strings.TrimSpace(domain))
	return strings.HasSuffix(d, ".local") || strings.HasSuffix(d, ".test") || strings.HasSuffix(d, ".example")
}

func (s *Sender) dialAndDeliver(ip net.IP, hostName, from string, recipients []string, raw string) error {
	addr := net.JoinHostPort(ip.String(), s.smtpPort)

	conn, err := net.DialTimeout("tcp4", addr, s.dialTimeout)
	if err != nil {
		return fmt.Errorf("failed to dial MX %s (%s): %w", hostName, addr, err)
	}
	defer conn.Close()

	deliveryTimeout := s.dialTimeout * 4
	if deliveryTimeout < 45*time.Second {
		deliveryTimeout = 45 * time.Second
	}
	_ = conn.SetDeadline(time.Now().Add(deliveryTimeout))

	client, err := netSMTP.NewClient(conn, hostName)
	if err != nil {
		return fmt.Errorf("smtp handshake error: %w", err)
	}
	defer client.Quit()

	if err := client.Hello(s.serverHostname); err != nil {
		log.Printf("[OUTBOUND WARNING] EHLO failed for hostname %s: %v", s.serverHostname, err)
	}

	if ok, _ := client.Extension("STARTTLS"); ok {
		tlsConfig := &tls.Config{
			ServerName: hostName,
			MinVersion: tls.VersionTLS12,
		}
		if err := client.StartTLS(tlsConfig); err != nil {
			_ = client.Close()
			return fmt.Errorf("STARTTLS required but failed with MX %s (%s): %w", hostName, addr, err)
		}
		log.Printf("[OUTBOUND] STARTTLS active: in-transit TLS encryption established with MX %s (%s)", hostName, addr)
	} else {
		_ = client.Close()
		return fmt.Errorf("STARTTLS not offered by MX %s (%s): refusing plaintext delivery", hostName, addr)
	}

	cleanFrom := cleanEmailAddr(from)
	if err := client.Mail(cleanFrom); err != nil {
		return err
	}

	for _, rcpt := range recipients {
		cleanRcpt := cleanEmailAddr(rcpt)
		if err := client.Rcpt(cleanRcpt); err != nil {
			return err
		}
	}

	w, err := client.Data()
	if err != nil {
		return err
	}

	if _, err = w.Write([]byte(raw)); err != nil {
		return err
	}

	return w.Close()
}

func cleanEmailAddr(addr string) string {
	clean := strings.TrimSpace(addr)
	if strings.ContainsAny(clean, "\r\n") {
		return ""
	}
	if parsed, err := mail.ParseAddress(clean); err == nil {
		if strings.ContainsAny(parsed.Address, "\r\n") {
			return ""
		}
		return parsed.Address
	}
	if idx := strings.LastIndex(clean, "<"); idx != -1 {
		clean = clean[idx+1:]
	}
	clean = strings.Trim(clean, "> ")
	return clean
}

func signDKIM(rawEmail string, domain, selector string, privKey *rsa.PrivateKey) (string, error) {
	options := &dkim.SignOptions{
		Domain:                 domain,
		Selector:               selector,
		Signer:                 privKey,
		Hash:                   crypto.SHA256,
		HeaderCanonicalization: dkim.CanonicalizationRelaxed,
		BodyCanonicalization:   dkim.CanonicalizationRelaxed,
		HeaderKeys:             []string{"From", "To", "Cc", "Reply-To", "Subject", "Date", "Message-ID", "MIME-Version", "Content-Type", "Content-Transfer-Encoding"},
	}

	var buf bytes.Buffer
	r := strings.NewReader(rawEmail)
	if err := dkim.Sign(&buf, r, options); err != nil {
		return "", err
	}
	return buf.String(), nil
}

func generateMessageID(fromDomain string) string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic("crypto/rand failure in generateMessageID")
	}
	cleanDomain := sanitizeDomainForHeader(fromDomain)
	if cleanDomain == "" {
		cleanDomain = "localhost"
	}
	return fmt.Sprintf("<%d.%s@%s>", time.Now().UnixNano(), hex.EncodeToString(b), cleanDomain)
}

func sanitizeDomainForHeader(d string) string {
	d = strings.ToLower(strings.TrimSpace(d))
	if len(d) == 0 || len(d) > 253 {
		return ""
	}
	for _, r := range d {
		if r <= 32 || r == 127 {
			return ""
		}
		if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '.' || r == '-') {
			return ""
		}
	}
	if strings.HasPrefix(d, "-") || strings.HasSuffix(d, "-") ||
		strings.HasPrefix(d, ".") || strings.HasSuffix(d, ".") ||
		strings.Contains(d, "..") {
		return ""
	}
	return d
}

func generateBoundary() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return fmt.Sprintf("====_mailergo_%d_%s====", time.Now().UnixNano(), hex.EncodeToString(b))
}

func buildRawMessage(req *models.OutboundSendRequest) string {
	senderDomain := domains.ExtractDomain(req.From)
	if senderDomain == "" {
		senderDomain = "localhost"
	}

	if req.Raw != "" {

		req.Raw = ""
	}

	var sb strings.Builder
	cleanFrom := mimeutil.SanitizeHeader(req.From)
	if req.FromName != "" {
		cleanAddr := cleanEmailAddr(req.From)
		if cleanAddr != "" {
			cleanFrom = (&mail.Address{
				Name:    req.FromName,
				Address: cleanAddr,
			}).String()
		}
	} else if parsed, err := mail.ParseAddress(cleanFrom); err == nil && parsed.Name != "" {
		cleanFrom = parsed.String()
	}
	var cleanRecipients []string
	for _, to := range req.To {
		if c := mimeutil.SanitizeHeader(to); c != "" {
			cleanRecipients = append(cleanRecipients, c)
		}
	}
	cleanSubject := mimeutil.SanitizeHeader(req.Subject)
	msgID := generateMessageID(senderDomain)

	sb.WriteString(fmt.Sprintf("From: %s\r\n", cleanFrom))
	sb.WriteString(fmt.Sprintf("To: %s\r\n", strings.Join(cleanRecipients, ", ")))
	sb.WriteString(fmt.Sprintf("Subject: %s\r\n", cleanSubject))
	sb.WriteString(fmt.Sprintf("Date: %s\r\n", time.Now().Format(time.RFC1123Z)))
	sb.WriteString(fmt.Sprintf("Message-ID: %s\r\n", msgID))
	sb.WriteString("MIME-Version: 1.0\r\n")

	htmlContent := strings.TrimSpace(req.HTML)
	textContent := strings.TrimSpace(req.Body)

	if htmlContent == "" && mimeutil.IsLikelyHTML(req.Body) {
		htmlContent = req.Body
		textContent = mimeutil.HTMLToText(req.Body)
	} else if htmlContent != "" && textContent == "" {
		textContent = mimeutil.HTMLToText(htmlContent)
	}

	hasAttachments := false
	for _, a := range req.Attachments {
		if a != nil && len(a.Data) > 0 {
			hasAttachments = true
			break
		}
	}

	if hasAttachments {
		mixedBoundary := generateBoundary()
		sb.WriteString(fmt.Sprintf("Content-Type: multipart/mixed; boundary=\"%s\"\r\n\r\n", mixedBoundary))

		sb.WriteString(fmt.Sprintf("--%s\r\n", mixedBoundary))
		if htmlContent != "" {
			altBoundary := generateBoundary()
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

		for _, att := range req.Attachments {
			if att == nil || len(att.Data) == 0 {
				continue
			}
			fn := sanitizeAttachmentFilename(att.Filename)
			if fn == "" {
				fn = "attachment"
			}
			ct := mimeutil.SanitizeHeader(att.ContentType)
			if mt, _, err := mime.ParseMediaType(ct); err == nil && mt != "" {
				ct = mt
			}
			if ct == "" {
				ct = "application/octet-stream"
			}
			sb.WriteString(fmt.Sprintf("--%s\r\n", mixedBoundary))
			sb.WriteString(fmt.Sprintf("Content-Type: %s; name=\"%s\"\r\n", ct, fn))
			sb.WriteString(fmt.Sprintf("Content-Disposition: attachment; filename=\"%s\"\r\n", fn))
			sb.WriteString("Content-Transfer-Encoding: base64\r\n\r\n")
			sb.WriteString(encodeBase64Lines(att.Data))
			sb.WriteString("\r\n")
		}

		sb.WriteString(fmt.Sprintf("--%s--\r\n", mixedBoundary))
	} else if htmlContent != "" {
		boundary := generateBoundary()
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

func encodeBase64Lines(data []byte) string {
	encoded := base64.StdEncoding.EncodeToString(data)
	var sb strings.Builder
	for i := 0; i < len(encoded); i += 76 {
		end := i + 76
		if end > len(encoded) {
			end = len(encoded)
		}
		sb.WriteString(encoded[i:end])
		sb.WriteString("\r\n")
	}
	return sb.String()
}

func sanitizeAttachmentFilename(fn string) string {
	fn = filepath.Base(fn)
	fn = strings.ReplaceAll(fn, "\"", "")
	fn = strings.ReplaceAll(fn, "\r", "")
	fn = strings.ReplaceAll(fn, "\n", "")
	return strings.TrimSpace(fn)
}
