package config

import (
	"crypto/rand"
	"encoding/hex"
	"log"
	"os"
	"strconv"
	"strings"
	"time"

	"mailer-go/backend/shared/envutil"
)

type Config struct {
	Env                    string
	TLSCertFile            string
	TLSKeyFile             string
	SMTPPort               string
	SMTPSubmissionPort     string
	HTTPPort               string
	AuthToken              string
	AESPassphrase          string
	MaxRAMMB               int64
	MaxDiskMB              int64
	MaxDiskMessages        int
	SQLitePath             string
	ServerHostname         string
	Debug                  bool
	MaxMessageMB           int64
	MaxRecipients          int
	SMTPReadTimeoutSec     int
	SMTPWriteTimeoutSec    int
	OutboundDialTimeoutSec int
	OutboundSMTPPort       string
	OutboundBodyLimitMB    int64
}

func Load() *Config {
	envutil.LoadDotEnv()

	env := envutil.Get("ENV", "production")
	isProd := isProduction(env)

	maxRAM := envutil.ParseInt64(os.Getenv("MAX_RAM_MB"), 64)
	maxDisk := envutil.ParseInt64(os.Getenv("MAX_DISK_MB"), 500)
	maxMessages := int(envutil.ParseInt64(os.Getenv("MAX_DISK_MESSAGES"), 10000))

	debug := false
	if val := os.Getenv("DEBUG"); val != "" {
		debug = val == "true" || val == "1"
	}

	authToken := os.Getenv("AUTH_TOKEN")
	if authToken == "" {
		if isProd {
			log.Fatal("[FATAL] AUTH_TOKEN is required in production. Refusing to start with an auto-generated token that would change on every restart. Set AUTH_TOKEN to a long random value.")
		}
		authToken = generateSecureToken(32)
		log.Printf("[SECURITY NOTICE] AUTH_TOKEN not set; generated an ephemeral development token. Do NOT use this in production.")
	}

	aesKey := os.Getenv("AES_KEY")
	if aesKey == "" {
		if isProd {
			log.Fatal("[FATAL] AES_KEY is required in production. Refusing to start with an auto-generated key that would change on every restart and make encrypted traffic undecryptable. Set AES_KEY to a long random value.")
		}
		aesKey = generateSecureToken(32)
		log.Printf("[SECURITY NOTICE] AES_KEY not set; generated an ephemeral development key. Do NOT use this in production.")
	}

	maxMessageMB := envutil.ParseInt64(os.Getenv("MAX_MESSAGE_MB"), 25)
	maxRecipients := int(envutil.ParseInt64(os.Getenv("MAX_RECIPIENTS"), 50))
	smtpReadTimeout := int(envutil.ParseInt64(os.Getenv("SMTP_READ_TIMEOUT_SEC"), 30))
	smtpWriteTimeout := int(envutil.ParseInt64(os.Getenv("SMTP_WRITE_TIMEOUT_SEC"), 30))
	outboundDialTimeout := int(envutil.ParseInt64(os.Getenv("OUTBOUND_DIAL_TIMEOUT_SEC"), 10))
	outboundBodyLimitMB := envutil.ParseInt64(os.Getenv("OUTBOUND_BODY_LIMIT_MB"), 64)

	return &Config{
		Env:                    env,
		TLSCertFile:            envutil.Get("TLS_CERT_FILE", ""),
		TLSKeyFile:             envutil.Get("TLS_KEY_FILE", ""),
		SMTPPort:               envutil.Get("SMTP_PORT", "25"),
		SMTPSubmissionPort:     envutil.Get("SMTP_SUBMISSION_PORT", ""),
		HTTPPort:               envutil.Get("HTTP_PORT", "8081"),
		AuthToken:              authToken,
		AESPassphrase:          aesKey,
		MaxRAMMB:               maxRAM,
		MaxDiskMB:              maxDisk,
		MaxDiskMessages:        maxMessages,
		SQLitePath:             envutil.Get("SQLITE_PATH", "smtp_spool.db"),
		ServerHostname:         envutil.Get("SERVER_HOSTNAME", "smtp.lukaulcar.com"),
		Debug:                  debug,
		MaxMessageMB:           maxMessageMB,
		MaxRecipients:          maxRecipients,
		SMTPReadTimeoutSec:     smtpReadTimeout,
		SMTPWriteTimeoutSec:    smtpWriteTimeout,
		OutboundDialTimeoutSec: outboundDialTimeout,
		OutboundSMTPPort:       envutil.Get("OUTBOUND_SMTP_PORT", "25"),
		OutboundBodyLimitMB:    outboundBodyLimitMB,
	}
}

func isProduction(env string) bool {
	switch strings.ToLower(strings.TrimSpace(env)) {
	case "", "production", "prod", "live":
		return true
	default:
		return false
	}
}

func (c *Config) IsProduction() bool {
	if c == nil {
		return true
	}
	return isProduction(c.Env)
}

func generateSecureToken(byteLen int) string {
	b := make([]byte, byteLen)
	if _, err := rand.Read(b); err != nil {
		return hex.EncodeToString([]byte(strconv.FormatInt(time.Now().UnixNano(), 16)))
	}
	return hex.EncodeToString(b)
}
