package dnschecker

import (
	"context"
	"fmt"
	"log"
	"net"
	"strings"
	"sync"
	"time"

	"mailer-go/backend/server/pkg/db"
	"mailer-go/backend/shared/models"
)

type OnDomainStatusChangeFunc func(domain *models.Domain, isNowActive bool)

type DNSChecker struct {
	db               *db.DB
	serverHost       string
	failThreshold    int
	rateLimitSeconds int
	resolverAddr     string
	dnsTimeout       time.Duration
	rateLimitMu      sync.Mutex
	lastCheckTime    map[string]time.Time
	failureCountMu   sync.Mutex
	consecutiveFails map[string]int
	onStatusChange   OnDomainStatusChangeFunc
}

func NewDNSChecker(
	database *db.DB,
	serverHost string,
	failThreshold int,
	rateLimitSeconds int,
	resolverAddr string,
	dnsTimeoutSeconds int,
	onStatusChange OnDomainStatusChangeFunc,
) *DNSChecker {
	if serverHost == "" || serverHost == "localhost" {
		serverHost = "smtp.lukaulcar.com"
	}
	if failThreshold <= 0 {
		failThreshold = 3
	}
	if rateLimitSeconds <= 0 {
		rateLimitSeconds = 30
	}
	if dnsTimeoutSeconds <= 0 {
		dnsTimeoutSeconds = 5
	}

	return &DNSChecker{
		db:               database,
		serverHost:       serverHost,
		failThreshold:    failThreshold,
		rateLimitSeconds: rateLimitSeconds,
		resolverAddr:     resolverAddr,
		dnsTimeout:       time.Duration(dnsTimeoutSeconds) * time.Second,
		lastCheckTime:    make(map[string]time.Time),
		consecutiveFails: make(map[string]int),
		onStatusChange:   onStatusChange,
	}
}

func (c *DNSChecker) CheckRateLimit(domain string) (allowed bool, retryAfterSec int) {
	clean := strings.ToLower(strings.TrimSpace(domain))
	c.rateLimitMu.Lock()
	defer c.rateLimitMu.Unlock()

	last, exists := c.lastCheckTime[clean]
	limitDuration := time.Duration(c.rateLimitSeconds) * time.Second
	if exists {
		elapsed := time.Since(last)
		if elapsed < limitDuration {
			retry := int((limitDuration - elapsed).Seconds()) + 1
			return false, retry
		}
	}

	c.lastCheckTime[clean] = time.Now()
	return true, 0
}

func (c *DNSChecker) RecordFailure(domain string) (consecutiveFailures int, thresholdReached bool) {
	c.failureCountMu.Lock()
	defer c.failureCountMu.Unlock()

	clean := strings.ToLower(strings.TrimSpace(domain))
	c.consecutiveFails[clean]++
	count := c.consecutiveFails[clean]
	threshold := c.failThreshold
	if threshold <= 0 {
		threshold = 3
	}
	return count, count >= threshold
}

func (c *DNSChecker) RecordSuccess(domain string) {
	c.failureCountMu.Lock()
	defer c.failureCountMu.Unlock()

	clean := strings.ToLower(strings.TrimSpace(domain))
	delete(c.consecutiveFails, clean)
}

func (c *DNSChecker) GetFailThreshold() int {
	if c.failThreshold <= 0 {
		return 3
	}
	return c.failThreshold
}

func (c *DNSChecker) getResolver(targetAddr string) *net.Resolver {
	if targetAddr != "" {
		target := targetAddr
		if !strings.Contains(target, ":") {
			target += ":53"
		}
		return &net.Resolver{
			PreferGo: true,
			Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
				d := net.Dialer{
					Timeout: c.dnsTimeout,
				}
				return d.DialContext(ctx, "udp", target)
			},
		}
	}
	return net.DefaultResolver
}

func (c *DNSChecker) tryLookupTXT(ctx context.Context, resolver *net.Resolver, host string) ([]string, error) {
	var txts []string
	var err error
	for attempt := 0; attempt < 2; attempt++ {
		txts, err = resolver.LookupTXT(ctx, host)
		if err == nil {
			return txts, nil
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
	return txts, err
}

func (c *DNSChecker) lookupTXT(ctx context.Context, host string) ([]string, error) {
	resolver := c.getResolver(c.resolverAddr)
	txts, err := c.tryLookupTXT(ctx, resolver, host)
	if err == nil && len(txts) > 0 {
		return txts, nil
	}

	if c.resolverAddr == "" {
		fbResolver := c.getResolver("1.1.1.1:53")
		fbTxts, fbErr := c.tryLookupTXT(ctx, fbResolver, host)
		if fbErr == nil && len(fbTxts) > 0 {
			return fbTxts, nil
		}
	}

	return txts, err
}

func (c *DNSChecker) tryLookupMX(ctx context.Context, resolver *net.Resolver, host string) ([]*net.MX, error) {
	var mxs []*net.MX
	var err error
	for attempt := 0; attempt < 2; attempt++ {
		mxs, err = resolver.LookupMX(ctx, host)
		if err == nil {
			return mxs, nil
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
	return mxs, err
}

func (c *DNSChecker) lookupMX(ctx context.Context, host string) ([]*net.MX, error) {
	resolver := c.getResolver(c.resolverAddr)
	mxs, err := c.tryLookupMX(ctx, resolver, host)
	if err == nil && len(mxs) > 0 {
		return mxs, nil
	}

	if c.resolverAddr == "" {
		fbResolver := c.getResolver("1.1.1.1:53")
		fbMxs, fbErr := c.tryLookupMX(ctx, fbResolver, host)
		if fbErr == nil && len(fbMxs) > 0 {
			return fbMxs, nil
		}
	}

	return mxs, err
}

func (c *DNSChecker) GenerateDNSRecords(domain, selector, pubKeyB64, serverHost string) []models.DNSRecord {
	if serverHost == "" || serverHost == "localhost" {
		serverHost = c.serverHost
	}
	if serverHost == "" || serverHost == "localhost" {
		serverHost = "smtp.lukaulcar.com"
	}
	if selector == "" {
		selector = "mail"
	}

	spfValue := fmt.Sprintf("v=spf1 mx a:%s ~all", serverHost)

	return []models.DNSRecord{
		{
			Type:    "TXT",
			Name:    "@",
			Value:   spfValue,
			Purpose: "SPF - Authorizes your mail server to send emails for this domain",
			Status:  "pending",
		},
		{
			Type:    "TXT",
			Name:    fmt.Sprintf("%s._domainkey", selector),
			Value:   fmt.Sprintf("v=DKIM1; k=rsa; p=%s", pubKeyB64),
			Purpose: "DKIM - Cryptographic public key for authenticating outbound emails",
			Status:  "pending",
		},
		{
			Type:    "TXT",
			Name:    "_dmarc",
			Value:   fmt.Sprintf("v=DMARC1; p=quarantine; sp=quarantine; rua=mailto:dmarc@%s;", domain),
			Purpose: "DMARC - Alignment and reporting policy for receivers (Gmail/Outlook)",
			Status:  "pending",
		},
		{
			Type:     "MX",
			Name:     "@",
			Value:    serverHost,
			Priority: 10,
			Purpose:  "MX - Routes incoming mail for this domain to your SMTP server",
			Status:   "pending",
		},
	}
}

func (c *DNSChecker) VerifyDomainDNS(domain, selector, pubKeyB64, serverHost string) (*models.DNSVerificationResult, error) {
	records := c.GenerateDNSRecords(domain, selector, pubKeyB64, serverHost)
	cleanDomain := strings.ToLower(strings.TrimSpace(domain))
	allVerified := true

	timeout := c.dnsTimeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}

	for i := range records {
		rec := &records[i]

		switch {
		case strings.HasPrefix(rec.Purpose, "SPF") || (rec.Type == "TXT" && strings.HasPrefix(rec.Value, "v=spf1")):
			queryCtx, cancel := context.WithTimeout(context.Background(), timeout)
			txts, err := c.lookupTXT(queryCtx, cleanDomain)
			cancel()

			if err != nil {
				rec.Status = "pending"
				rec.Error = fmt.Sprintf("DNS lookup failed for TXT %s: %v", cleanDomain, err)
				rec.CurrentValue = "<lookup error>"
				allVerified = false
			} else if len(txts) == 0 {
				rec.Status = "pending"
				rec.Error = fmt.Sprintf("No TXT records found at %s. Expected SPF record containing 'v=spf1'.", cleanDomain)
				rec.CurrentValue = "<none>"
				allVerified = false
			} else {
				var matched string
				for _, t := range txts {
					if strings.Contains(strings.ToLower(t), "v=spf1") {
						matched = t
						break
					}
				}
				if matched != "" {
					rec.Status = "verified"
					rec.CurrentValue = matched
					rec.Error = ""
				} else {
					rec.Status = "pending"
					rec.CurrentValue = strings.Join(txts, " | ")
					rec.Error = fmt.Sprintf("Found %d TXT record(s) on %s, but none contain 'v=spf1'.", len(txts), cleanDomain)
					allVerified = false
				}
			}

		case strings.HasPrefix(rec.Purpose, "DKIM") || strings.Contains(rec.Name, "_domainkey"):
			dkimHost := fmt.Sprintf("%s._domainkey.%s", selector, cleanDomain)
			queryCtx, cancel := context.WithTimeout(context.Background(), timeout)
			txts, err := c.lookupTXT(queryCtx, dkimHost)
			cancel()

			if err != nil {
				rec.Status = "pending"
				rec.Error = fmt.Sprintf("DNS lookup failed for %s: %v", dkimHost, err)
				rec.CurrentValue = "<lookup error>"
				allVerified = false
			} else if len(txts) == 0 {
				rec.Status = "pending"
				rec.Error = fmt.Sprintf("No TXT records found at %s. Ensure a TXT record with Host/Name '%s._domainkey' is added in your DNS zone.", dkimHost, selector)
				rec.CurrentValue = "<none>"
				allVerified = false
			} else {
				cleanTargetKey := strings.ReplaceAll(strings.ReplaceAll(strings.ReplaceAll(pubKeyB64, " ", ""), "\n", ""), "\r", "")
				joinedAll := strings.Join(txts, "")
				cleanJoined := strings.ReplaceAll(strings.ReplaceAll(strings.ReplaceAll(strings.ReplaceAll(joinedAll, " ", ""), `"`, ""), "\n", ""), "\r", "")

				verified := false
				if cleanTargetKey != "" && strings.Contains(cleanJoined, cleanTargetKey) {
					verified = true
				} else {
					for _, t := range txts {
						cleanT := strings.ReplaceAll(strings.ReplaceAll(strings.ReplaceAll(strings.ReplaceAll(t, " ", ""), `"`, ""), "\n", ""), "\r", "")
						if cleanTargetKey != "" && strings.Contains(cleanT, cleanTargetKey) {
							verified = true
							break
						}
					}
				}

				if verified {
					rec.Status = "verified"
					rec.CurrentValue = joinedAll
					rec.Error = ""
				} else {
					rec.Status = "pending"
					rec.CurrentValue = joinedAll
					if len(rec.CurrentValue) > 160 {
						rec.CurrentValue = rec.CurrentValue[:160] + "..."
					}
					rec.Error = fmt.Sprintf("DKIM TXT record found at %s, but public key 'p=' does not match expected key for selector '%s'.", dkimHost, selector)
					allVerified = false
				}
			}

		case strings.HasPrefix(rec.Purpose, "DMARC") || strings.Contains(rec.Name, "_dmarc"):
			dmarcHost := fmt.Sprintf("_dmarc.%s", cleanDomain)
			queryCtx, cancel := context.WithTimeout(context.Background(), timeout)
			txts, err := c.lookupTXT(queryCtx, dmarcHost)
			cancel()

			if err != nil {
				rec.Status = "pending"
				rec.Error = fmt.Sprintf("DNS lookup failed for %s: %v", dmarcHost, err)
				rec.CurrentValue = "<lookup error>"
				allVerified = false
			} else if len(txts) == 0 {
				rec.Status = "pending"
				rec.Error = fmt.Sprintf("No TXT records found at %s. Expected DMARC record containing 'v=DMARC1'.", dmarcHost)
				rec.CurrentValue = "<none>"
				allVerified = false
			} else {
				var matched string
				for _, t := range txts {
					if strings.Contains(strings.ToLower(t), "v=dmarc1") {
						matched = t
						break
					}
				}
				if matched != "" {
					rec.Status = "verified"
					rec.CurrentValue = matched
					rec.Error = ""
				} else {
					rec.Status = "pending"
					rec.CurrentValue = strings.Join(txts, " | ")
					rec.Error = fmt.Sprintf("Found %d TXT record(s) at %s, but none contain 'v=DMARC1'.", len(txts), dmarcHost)
					allVerified = false
				}
			}

		case strings.HasPrefix(rec.Purpose, "MX") || rec.Type == "MX":
			queryCtx, cancel := context.WithTimeout(context.Background(), timeout)
			mxs, err := c.lookupMX(queryCtx, cleanDomain)
			cancel()

			if err != nil {
				rec.Status = "pending"
				rec.Error = fmt.Sprintf("DNS lookup failed for MX on %s: %v", cleanDomain, err)
				rec.CurrentValue = "<lookup error>"
				allVerified = false
			} else if len(mxs) == 0 {
				rec.Status = "pending"
				rec.Error = fmt.Sprintf("No MX records found for %s. Expected MX pointing to '%s'.", cleanDomain, serverHost)
				rec.CurrentValue = "<none>"
				allVerified = false
			} else {
				cleanExpected := strings.TrimSuffix(strings.ToLower(serverHost), ".")
				var mxStrings []string
				verified := false
				var matchedMX string
				for _, m := range mxs {
					cleanMX := strings.TrimSuffix(strings.ToLower(m.Host), ".")
					mxStr := fmt.Sprintf("%s (pri %d)", cleanMX, m.Pref)
					mxStrings = append(mxStrings, mxStr)
					if cleanExpected == "localhost" || strings.EqualFold(cleanMX, cleanExpected) {
						verified = true
						matchedMX = mxStr
					}
				}

				if verified {
					rec.Status = "verified"
					rec.CurrentValue = matchedMX
					rec.Error = ""
				} else {
					rec.Status = "pending"
					rec.CurrentValue = strings.Join(mxStrings, ", ")
					rec.Error = fmt.Sprintf("Found MX record(s) [%s], but none match expected mail server '%s'.", strings.Join(mxStrings, ", "), serverHost)
					allVerified = false
				}
			}
		}
	}

	var summaryParts []string
	for _, r := range records {
		if r.Status == "verified" {
			summaryParts = append(summaryParts, fmt.Sprintf("  [OK] [%s %s] Status: verified (Found: %s)", r.Type, r.Name, r.CurrentValue))
		} else {
			summaryParts = append(summaryParts, fmt.Sprintf("  [FAIL] [%s %s] Status: pending/failed\n     Expected: %s\n     Reason:   %s\n     Current:  %s",
				r.Type, r.Name, r.Value, r.Error, r.CurrentValue))
		}
	}

	return &models.DNSVerificationResult{
		Domain:         cleanDomain,
		AllVerified:    allVerified,
		Records:        records,
		FailureSummary: strings.Join(summaryParts, "\n"),
	}, nil
}

func (c *DNSChecker) VerifyAndUpdateDomain(domainName string) (*models.DNSVerificationResult, *models.Domain, error) {
	dom, err := c.db.GetDomain(domainName)
	if err != nil {
		return nil, nil, err
	}

	res, err := c.VerifyDomainDNS(dom.Name, dom.Selector, dom.DKIMPublicKeyB64, c.serverHost)
	if err != nil {
		return nil, dom, err
	}

	spfStatus := "pending"
	dkimStatus := "pending"
	dmarcStatus := "pending"
	mxStatus := "pending"

	for _, r := range res.Records {
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

	now := time.Now().Unix()
	wasVerified := dom.IsVerified

	if res.AllVerified {
		c.RecordSuccess(dom.Name)
		_ = c.db.UpdateDomainDNSStatus(dom.Name, true, spfStatus, dkimStatus, dmarcStatus, mxStatus, now)

		if !wasVerified || !dom.IsActive {
			_ = c.db.SetDomainActive(dom.Name, true)
			dom, _ = c.db.GetDomain(dom.Name)
			if c.onStatusChange != nil {
				c.onStatusChange(dom, true)
			}
			log.Printf("[DNS WORKER SUCCESS] Domain %s DNS records are VERIFIED! Activated and triggered sync push to MX servers.\nDNS verification details:\n%s",
				dom.Name, res.FailureSummary)
		} else {
			log.Printf("[DNS WORKER OK] Domain %s DNS records re-verified successfully.", dom.Name)
		}
	} else {
		if wasVerified || dom.IsActive {
			fails, thresholdReached := c.RecordFailure(dom.Name)
			if thresholdReached {
				log.Printf("================================================================================\n"+
					"[DNS WORKER ALERT] Domain %s DNS check failed %d consecutive times (threshold %d reached)!\n"+
					"Domain marked INACTIVE and scheduled for removal from MX servers.\n"+
					"Invalid or missing DNS record breakdown:\n%s\n"+
					"================================================================================",
					dom.Name, fails, c.GetFailThreshold(), res.FailureSummary)
				_ = c.db.UpdateDomainDNSStatus(dom.Name, false, spfStatus, dkimStatus, dmarcStatus, mxStatus, now)
				_ = c.db.SetDomainActive(dom.Name, false)
				dom, _ = c.db.GetDomain(dom.Name)
				if c.onStatusChange != nil {
					c.onStatusChange(dom, false)
				}
			} else {
				log.Printf("--------------------------------------------------------------------------------\n"+
					"[DNS WORKER WARNING] Domain %s DNS check flagged issue (attempt %d/%d consecutive failures).\n"+
					"Domain remains ACTIVE on MX servers.\n"+
					"Pending/failing record breakdown:\n%s\n"+
					"--------------------------------------------------------------------------------",
					dom.Name, fails, c.GetFailThreshold(), res.FailureSummary)
				_ = c.db.UpdateDomainDNSStatus(dom.Name, true, spfStatus, dkimStatus, dmarcStatus, mxStatus, now)
			}
		} else {
			_ = c.db.UpdateDomainDNSStatus(dom.Name, false, spfStatus, dkimStatus, dmarcStatus, mxStatus, now)
		}
	}

	updatedDom, _ := c.db.GetDomain(dom.Name)
	return res, updatedDom, nil
}

func (c *DNSChecker) StartBackgroundWorker(ctx context.Context, interval time.Duration) {
	if interval < 10*time.Second {
		interval = 5 * time.Minute
	}

	go func() {
		log.Printf("[DNS WORKER] Background DNS verification worker started (interval: %v, failure threshold: %d, timeout: %v)",
			interval, c.GetFailThreshold(), c.dnsTimeout)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()

		for {
			select {
			case <-ctx.Done():
				log.Println("[DNS WORKER] Worker stopped.")
				return
			case <-ticker.C:
				c.runPeriodicReverification()
			}
		}
	}()
}

func (c *DNSChecker) runPeriodicReverification() {
	domains, err := c.db.ListDomains()
	if err != nil {
		log.Printf("[DNS WORKER] Failed to list domains: %v", err)
		return
	}

	for _, dom := range domains {
		_, updatedDom, err := c.VerifyAndUpdateDomain(dom.Name)
		if err != nil {
			log.Printf("[DNS WORKER] Warning: failed to verify %s: %v", dom.Name, err)
			continue
		}
		_ = updatedDom
	}
}
