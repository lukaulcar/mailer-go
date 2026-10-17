package crypto

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"fmt"
	"net/mail"
	"strings"
)

func GenerateRSAKey(bits int) (string, string, *rsa.PrivateKey, error) {
	if bits < 2048 {
		bits = 2048
	}

	key, err := rsa.GenerateKey(rand.Reader, bits)
	if err != nil {
		return "", "", nil, fmt.Errorf("rsa generate error: %w", err)
	}

	privBytes, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return "", "", nil, fmt.Errorf("pkcs8 marshal error: %w", err)
	}

	privBlock := &pem.Block{
		Type:  "PRIVATE KEY",
		Bytes: privBytes,
	}
	privPEM := string(pem.EncodeToMemory(privBlock))

	pubBytes, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		return "", "", nil, fmt.Errorf("pkix marshal error: %w", err)
	}
	pubB64 := base64.StdEncoding.EncodeToString(pubBytes)

	return privPEM, pubB64, key, nil
}

func ParsePrivateKeyPEM(pemStr string) (*rsa.PrivateKey, error) {
	block, _ := pem.Decode([]byte(pemStr))
	if block == nil {
		return nil, fmt.Errorf("failed to decode PEM block")
	}

	if key, err := x509.ParsePKCS8PrivateKey(block.Bytes); err == nil {
		if rsaKey, ok := key.(*rsa.PrivateKey); ok {
			if err := checkRSAKeyStrength(rsaKey); err != nil {
				return nil, err
			}
			return rsaKey, nil
		}
	}

	if rsaKey, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		if err := checkRSAKeyStrength(rsaKey); err != nil {
			return nil, err
		}
		return rsaKey, nil
	}

	return nil, fmt.Errorf("unsupported private key format")
}

func checkRSAKeyStrength(k *rsa.PrivateKey) error {
	if k == nil {
		return fmt.Errorf("nil RSA key")
	}
	if k.N == nil || k.N.BitLen() < 2048 {
		return fmt.Errorf("RSA key too weak: require >= 2048 bits")
	}

	if k.E < 65537 {
		return fmt.Errorf("RSA exponent too small: require e >= 65537")
	}
	return nil
}

func ExtractDomain(addr string) string {
	clean := strings.TrimSpace(addr)
	clean = strings.TrimPrefix(clean, "<")
	clean = strings.TrimSuffix(clean, ">")
	clean = strings.TrimSpace(clean)

	if parsed, err := mail.ParseAddress(addr); err == nil {
		clean = parsed.Address
	} else if parsed, err := mail.ParseAddress(clean); err == nil {
		clean = parsed.Address
	}

	parts := strings.Split(clean, "@")
	if len(parts) < 2 {
		return ""
	}

	domain := strings.ToLower(strings.TrimSpace(parts[len(parts)-1]))
	if !ValidateDomain(domain) {
		return ""
	}
	return domain
}

func ValidateDomain(domain string) bool {
	d := strings.ToLower(strings.TrimSpace(domain))
	if d == "" || len(d) > 253 {
		return false
	}

	for _, r := range d {
		if r <= 32 || r == 127 {
			return false
		}
	}
	if strings.ContainsAny(d, "/\\ :;,[]()<>\"@\r\n\t") {
		return false
	}
	if strings.HasPrefix(d, "-") || strings.HasSuffix(d, "-") ||
		strings.HasPrefix(d, ".") || strings.HasSuffix(d, ".") ||
		strings.Contains(d, "..") {
		return false
	}
	for _, label := range strings.Split(d, ".") {
		if label == "" || len(label) > 63 {
			return false
		}
		if strings.HasPrefix(label, "-") || strings.HasSuffix(label, "-") {
			return false
		}
	}
	return true
}
