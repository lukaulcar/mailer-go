package config

import (
	"log"
	"os"
	"strings"

	"mailer-go/backend/shared/envutil"
)

type Config struct {
	Mode                    string
	HTTPPort                string
	SMTPServiceURL          string
	SMTPServiceWS           string
	AuthToken               string
	AESPassphrase           string
	CentralDBPath           string
	StoragePath             string
	BaseUsersDir            string
	AdminEmail              string
	SelfHosted              bool
	ServerHostname          string
	DomainSyncIntervalSec   int
	DNSCheckIntervalMinutes int
	DNSFailThreshold        int
	DNSRateLimitSeconds     int
	DNSResolver             string
	DNSTimeoutSeconds       int
	CORSAllowedOrigins      string
	HTTPReadTimeoutSec      int
	HTTPIdleTimeoutSec      int
	RelayWSReadLimitMB      int64
	RelayReconnectSec       int
	RelayPingIntervalSec    int
	RelayReadDeadlineSec    int
}

func (c *Config) IsLive() bool {
	return strings.ToLower(c.Mode) == "live"
}

func Load() *Config {
	envutil.LoadDotEnv()

	authToken := envutil.Get("AUTH_TOKEN", "generate-a-strong-32-character-token-here")
	if authToken == "" {
		log.Println("[SECURITY WARNING] AUTH_TOKEN is not set in backend server environment!")
	}

	aesKey := envutil.Get("AES_KEY", "generate-a-strong-32-character-aes-key-here")
	if aesKey == "" {
		log.Println("[SECURITY WARNING] AES_KEY is not set in backend server environment!")
	}

	dnsInterval := envutil.ParseInt(os.Getenv("DNS_CHECK_INTERVAL_MINUTES"), 5)
	dnsFailThreshold := envutil.ParseInt(os.Getenv("DNS_FAIL_THRESHOLD"), 3)
	if dnsFailThreshold <= 0 {
		dnsFailThreshold = 3
	}

	dnsRateLimit := envutil.ParseInt(os.Getenv("DNS_RATE_LIMIT_SECONDS"), 30)
	dnsTimeout := envutil.ParseInt(os.Getenv("DNS_TIMEOUT_SECONDS"), 5)
	readTimeout := envutil.ParseInt(os.Getenv("HTTP_READ_TIMEOUT_SEC"), 10)
	idleTimeout := envutil.ParseInt(os.Getenv("HTTP_IDLE_TIMEOUT_SEC"), 120)

	mode := strings.ToLower(strings.TrimSpace(envutil.Get("MODE", "")))
	if mode == "" {
		if os.Getenv("SELF_HOSTED") == "true" || os.Getenv("SELF_HOSTED") == "1" {
			mode = "local"
		} else {
			mode = "live"
		}
	}
	selfHosted := mode == "local" || os.Getenv("SELF_HOSTED") == "true" || os.Getenv("SELF_HOSTED") == "1"

	relayWSReadLimitMB := envutil.ParseInt64(os.Getenv("RELAY_WS_READ_LIMIT_MB"), 64)
	relayReconnectSec := envutil.ParseInt(os.Getenv("RELAY_RECONNECT_INTERVAL_SEC"), 3)
	relayPingIntervalSec := envutil.ParseInt(os.Getenv("RELAY_PING_INTERVAL_SEC"), 20)
	relayReadDeadlineSec := envutil.ParseInt(os.Getenv("RELAY_READ_DEADLINE_SEC"), 60)

	return &Config{
		Mode:                    mode,
		HTTPPort:                envutil.Get("HTTP_PORT", "8082"),
		SMTPServiceURL:          envutil.Get("SMTP_SERVICE_URL", "http://localhost:8081"),
		SMTPServiceWS:           envutil.Get("SMTP_SERVICE_WS", "ws://localhost:8081/ws"),
		AuthToken:               authToken,
		AESPassphrase:           aesKey,
		CentralDBPath:           envutil.Get("CENTRAL_DB_PATH", "central_backend.db"),
		StoragePath:             envutil.Get("STORAGE_PATH", "data/storage"),
		BaseUsersDir:            envutil.Get("BASE_USERS_DIR", "data/users"),
		AdminEmail:              strings.ToLower(strings.TrimSpace(envutil.Get("ADMIN_EMAIL", ""))),
		SelfHosted:              selfHosted,
		ServerHostname:          envutil.Get("SERVER_HOSTNAME", "smtp.lukaulcar.com"),
		DomainSyncIntervalSec:   int(envutil.ParseInt64(os.Getenv("DOMAIN_SYNC_INTERVAL_SEC"), 60)),
		DNSCheckIntervalMinutes: dnsInterval,
		DNSFailThreshold:        dnsFailThreshold,
		DNSRateLimitSeconds:     dnsRateLimit,
		DNSResolver:             envutil.Get("DNS_RESOLVER", ""),
		DNSTimeoutSeconds:       dnsTimeout,
		CORSAllowedOrigins:      envutil.Get("CORS_ALLOWED_ORIGINS", "*"),
		HTTPReadTimeoutSec:      readTimeout,
		HTTPIdleTimeoutSec:      idleTimeout,
		RelayWSReadLimitMB:      relayWSReadLimitMB,
		RelayReconnectSec:       relayReconnectSec,
		RelayPingIntervalSec:    relayPingIntervalSec,
		RelayReadDeadlineSec:    relayReadDeadlineSec,
	}
}
