package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
)

var (
	ErrInvalidCiphertext = errors.New("invalid ciphertext: too short")
	ErrDecryptionFailed  = errors.New("decryption failed: authentication tag mismatch")
)

type Encryptor struct {
	key               []byte
	maxCiphertextSize int64
}

func NewEncryptor(passphrase string) *Encryptor {

	key := pbkdf2SHA256([]byte(passphrase), []byte("mailer-go-aes-v1"), 210000, 32)
	maxMB := int64(100)
	if val := os.Getenv("MAX_CIPHERTEXT_MB"); val != "" {
		if n, err := strconv.ParseInt(val, 10, 64); err == nil && n > 0 {
			maxMB = n
		}
	}
	return &Encryptor{
		key:               key,
		maxCiphertextSize: maxMB * 1024 * 1024,
	}
}

func (e *Encryptor) Encrypt(plaintext []byte) (string, error) {
	block, err := aes.NewCipher(e.key)
	if err != nil {
		return "", err
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}

	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}

	ciphertext := gcm.Seal(nonce, nonce, plaintext, nil)
	return base64.StdEncoding.EncodeToString(ciphertext), nil
}

func (e *Encryptor) Decrypt(b64Ciphertext string) ([]byte, error) {
	limit := e.maxCiphertextSize
	if limit <= 0 {
		limit = 100 * 1024 * 1024
	}
	if int64(len(b64Ciphertext)) > limit {
		return nil, fmt.Errorf("ciphertext too large (%d > %d bytes limit)", len(b64Ciphertext), limit)
	}
	data, err := base64.StdEncoding.DecodeString(b64Ciphertext)
	if err != nil {
		return nil, err
	}

	block, err := aes.NewCipher(e.key)
	if err != nil {
		return nil, err
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}

	nonceSize := gcm.NonceSize()
	if len(data) < nonceSize {
		return nil, ErrInvalidCiphertext
	}

	nonce, ciphertext := data[:nonceSize], data[nonceSize:]
	plaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return nil, ErrDecryptionFailed
	}

	return plaintext, nil
}

func GenerateID(prefix string) string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic("crypto/rand failure in GenerateID")
	}
	return fmt.Sprintf("%s_%s", prefix, hex.EncodeToString(b))
}

func pbkdf2SHA256(password, salt []byte, iter, keyLen int) []byte {
	hLen := 32
	numBlocks := (keyLen + hLen - 1) / hLen
	var out []byte
	for block := 1; block <= numBlocks; block++ {
		mac := hmac.New(sha256.New, password)
		mac.Write(salt)
		mac.Write([]byte{byte(block >> 24), byte(block >> 16), byte(block >> 8), byte(block)})
		u := mac.Sum(nil)
		t := make([]byte, len(u))
		copy(t, u)
		for i := 1; i < iter; i++ {
			mac = hmac.New(sha256.New, password)
			mac.Write(u)
			u = mac.Sum(nil)
			for j := range t {
				t[j] ^= u[j]
			}
		}
		out = append(out, t...)
	}
	return out[:keyLen]
}

func HashPassword(password string) string {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		panic("crypto/rand failure in HashPassword")
	}

	dk := pbkdf2SHA256([]byte(password), salt, 210000, 32)
	return fmt.Sprintf("pbkdf2-sha256$210000$%s$%s", hex.EncodeToString(salt), hex.EncodeToString(dk))
}

func VerifyPassword(password, storedHash string) bool {

	parts := strings.Split(storedHash, "$")
	if len(parts) == 4 && parts[0] == "pbkdf2-sha256" {
		iter, err := strconv.Atoi(parts[1])
		if err != nil || iter <= 0 || iter > 1000000 {
			return false
		}
		salt, err := hex.DecodeString(parts[2])
		if err != nil {
			return false
		}
		expected, err := hex.DecodeString(parts[3])
		if err != nil || len(expected) == 0 {
			return false
		}
		calc := pbkdf2SHA256([]byte(password), salt, iter, len(expected))
		return subtle.ConstantTimeCompare(calc, expected) == 1
	}

	if len(parts) != 2 {
		return false
	}
	salt, err := hex.DecodeString(parts[0])
	if err != nil {
		return false
	}
	expectedHash := parts[1]
	h := sha256.Sum256(append(salt, []byte(password)...))
	calcHash := hex.EncodeToString(h[:])
	return subtle.ConstantTimeCompare([]byte(calcHash), []byte(expectedHash)) == 1
}
