package verifier

import (
	"bytes"
	"fmt"
	"log"
	"net"
	"net/mail"
	"strings"

	"blitiri.com.ar/go/spf"
	"github.com/emersion/go-msgauth/dkim"
	"github.com/emersion/go-msgauth/dmarc"
	"mailer-go/backend/shared/models"
	"mailer-go/backend/smtp/pkg/domains"
)

type Verifier struct{}

func NewVerifier() *Verifier {
	return &Verifier{}
}

func (v *Verifier) Verify(rawBytes []byte, from string, clientIP string, helo string, tlsUsed bool) *models.VerificationResult {
	envelopeDomain := domains.ExtractDomain(from)

	headerDomain := headerFromDomain(rawBytes)
	if headerDomain == "" {
		headerDomain = envelopeDomain
	}

	result := &models.VerificationResult{
		IsVerified: false,
		SPF:        "none",
		DKIM:       "none",
		DMARC:      "none",
		ClientIP:   clientIP,
		TLS:        tlsUsed,
		Summary:    "Unverified sender",
	}

	if clientIP != "" && from != "" {
		netIP := net.ParseIP(clientIP)
		if netIP != nil {
			spfRes, err := spf.CheckHostWithSender(netIP, helo, from)
			result.SPF = strings.ToLower(string(spfRes))
			if err != nil && result.SPF == "" {
				log.Printf("[VERIFIER] SPF check warning for IP %s (from %s): %v", clientIP, from, err)
				result.SPF = "temperror"
			}
		}
	}

	var validDKIMDomains []string
	if len(rawBytes) > 0 {
		verifications, err := dkim.Verify(bytes.NewReader(rawBytes))
		if err == nil && len(verifications) > 0 {
			anyValid := false
			for _, ver := range verifications {
				if ver.Err == nil {
					anyValid = true
					if ver.Domain != "" {
						validDKIMDomains = append(validDKIMDomains, ver.Domain)
					}
				} else {
					log.Printf("[VERIFIER] DKIM signature check failed for domain %s: %v", ver.Domain, ver.Err)
				}
			}
			if anyValid {
				result.DKIM = "pass"
			} else {
				result.DKIM = "fail"
			}
		} else if err != nil {
			log.Printf("[VERIFIER] DKIM verification error: %v", err)
			result.DKIM = "fail"
		}
	}

	spfAligned := result.SPF == "pass" && domainsAligned(envelopeDomain, headerDomain)

	var alignedDKIMDomains []string
	for _, d := range validDKIMDomains {
		if domainsAligned(d, headerDomain) {
			alignedDKIMDomains = append(alignedDKIMDomains, d)
		}
	}
	dkimAligned := len(alignedDKIMDomains) > 0

	if headerDomain != "" {
		dmarcRecord, err := dmarc.Lookup(headerDomain)
		if err == nil && dmarcRecord != nil {
			if spfAligned || dkimAligned {
				result.DMARC = "pass"
			} else {
				result.DMARC = "fail"
			}
		}
	}

	if result.DMARC == "pass" || dkimAligned || spfAligned {
		result.IsVerified = true

		var reasons []string
		if dkimAligned {
			reasons = append(reasons, fmt.Sprintf("DKIM signed and aligned (%s)", strings.Join(alignedDKIMDomains, ", ")))
		}
		if spfAligned {
			reasons = append(reasons, fmt.Sprintf("SPF aligned and matched IP %s", clientIP))
		}
		if result.DMARC == "pass" {
			reasons = append(reasons, "DMARC aligned")
		}

		result.Summary = fmt.Sprintf("Verified authentic sender: %s", strings.Join(reasons, "; "))
	} else {
		result.IsVerified = false
		result.Summary = fmt.Sprintf("Unverified sender: SPF=%s, DKIM=%s, DMARC=%s (from=%s)",
			result.SPF, result.DKIM, result.DMARC, headerDomain)
	}

	return result
}

func headerFromDomain(raw []byte) string {
	msg, err := mail.ReadMessage(bytes.NewReader(raw))
	if err != nil {
		return ""
	}
	from := msg.Header.Get("From")
	if from == "" {
		return ""
	}
	if addr, err := mail.ParseAddress(from); err == nil {
		return domains.ExtractDomain(addr.Address)
	}
	return domains.ExtractDomain(from)
}

func domainsAligned(a, b string) bool {
	a = strings.ToLower(strings.TrimSpace(a))
	b = strings.ToLower(strings.TrimSpace(b))
	if a == "" || b == "" {
		return false
	}
	if a == b {
		return true
	}
	return strings.HasSuffix(a, "."+b) || strings.HasSuffix(b, "."+a)
}
