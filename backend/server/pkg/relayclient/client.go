package relayclient

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"mailer-go/backend/server/pkg/config"
	"mailer-go/backend/shared/crypto"
	"mailer-go/backend/shared/models"
)

type RelayClient struct {
	cfg        *config.Config
	encryptor  *crypto.Encryptor
	httpClient *http.Client
	mu         sync.Mutex
	writeMu    sync.Mutex
	conn       *websocket.Conn
	connected  bool
	onConnect  func()
}

func (c *RelayClient) SetOnConnect(fn func()) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.onConnect = fn
}

func NewRelayClient(cfg *config.Config, encryptor *crypto.Encryptor) *RelayClient {
	return &RelayClient{
		cfg:       cfg,
		encryptor: encryptor,
		httpClient: &http.Client{
			Timeout: 60 * time.Second,
		},
	}
}

func (c *RelayClient) IsConnected() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.connected
}

func (c *RelayClient) StartWSListener(ctx context.Context, onMail func(mail *models.MailMessage)) {
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			default:
				if err := c.connectAndListen(ctx, onMail); err != nil {
					retrySec := c.cfg.RelayReconnectSec
					if retrySec <= 0 {
						retrySec = 3
					}
					log.Printf("[RELAY CLIENT] Connection dropped: %v. Retrying in %d seconds...", err, retrySec)
					select {
					case <-ctx.Done():
						return
					case <-time.After(time.Duration(retrySec) * time.Second):
					}
				}
			}
		}
	}()
}

func (c *RelayClient) connectAndListen(ctx context.Context, onMail func(mail *models.MailMessage)) error {
	wsURL, err := url.Parse(c.cfg.SMTPServiceWS)
	if err != nil {
		return err
	}
	q := wsURL.Query()
	q.Set("token", c.cfg.AuthToken)
	wsURL.RawQuery = q.Encode()

	headers := http.Header{}
	headers.Set("Authorization", "Bearer "+c.cfg.AuthToken)

	log.Printf("[RELAY CLIENT] Connecting to live mail WebSocket at %s...", c.cfg.SMTPServiceWS)
	dialer := &websocket.Dialer{
		Proxy:            http.ProxyFromEnvironment,
		HandshakeTimeout: 15 * time.Second,
		ReadBufferSize:   1024 * 64,
		WriteBufferSize:  1024 * 64,
	}
	conn, _, err := dialer.DialContext(ctx, wsURL.String(), headers)
	if err != nil {
		return fmt.Errorf("websocket dial failed: %w", err)
	}

	c.mu.Lock()
	c.conn = conn
	c.connected = true
	onConnectCb := c.onConnect
	c.mu.Unlock()

	log.Println("[RELAY CLIENT] Successfully connected to SMTP relay! Live mail stream is active.")
	if onConnectCb != nil {
		go onConnectCb()
	}

	readLimitMB := c.cfg.RelayWSReadLimitMB
	if readLimitMB <= 0 {
		readLimitMB = 64
	}
	readDeadlineSec := c.cfg.RelayReadDeadlineSec
	if readDeadlineSec <= 0 {
		readDeadlineSec = 60
	}
	pingIntervalSec := c.cfg.RelayPingIntervalSec
	if pingIntervalSec <= 0 {
		pingIntervalSec = 20
	}

	conn.SetReadLimit(readLimitMB * 1024 * 1024)
	_ = conn.SetReadDeadline(time.Now().Add(time.Duration(readDeadlineSec) * time.Second))
	conn.SetPongHandler(func(string) error {
		_ = conn.SetReadDeadline(time.Now().Add(time.Duration(readDeadlineSec) * time.Second))
		return nil
	})

	done := make(chan struct{})
	defer func() {
		close(done)
		c.mu.Lock()
		c.connected = false
		if c.conn != nil {
			_ = c.conn.Close()
			c.conn = nil
		}
		c.mu.Unlock()
	}()

	go func() {
		ticker := time.NewTicker(time.Duration(pingIntervalSec) * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ctx.Done():
				c.writeMu.Lock()
				_ = conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
				_ = conn.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
				c.writeMu.Unlock()
				return
			case <-ticker.C:
				c.writeMu.Lock()
				_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
				err := conn.WriteMessage(websocket.PingMessage, []byte("relay_ping"))
				c.writeMu.Unlock()
				if err != nil {
					_ = conn.Close()
					return
				}
			}
		}
	}()

	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			return err
		}
		_ = conn.SetReadDeadline(time.Now().Add(time.Duration(readDeadlineSec) * time.Second))

		var envelope models.EncryptedEnvelope
		if err := json.Unmarshal(data, &envelope); err != nil {
			log.Printf("[RELAY CLIENT] Warning: malformed envelope: %v", err)
			continue
		}

		decrypted, err := c.encryptor.Decrypt(envelope.Payload)
		if err != nil {
			log.Printf("[RELAY CLIENT] Error decrypting mail envelope: %v", err)
			continue
		}

		var mail models.MailMessage
		if err := json.Unmarshal(decrypted, &mail); err != nil {
			log.Printf("[RELAY CLIENT] Error deserializing mail object: %v", err)
			continue
		}

		log.Printf("[RELAY CLIENT] Decrypted live mail %s from <%s> (Subject: %q)",
			mail.ID, mail.From, mail.Subject)

		if onMail != nil {
			onMail(&mail)
		}
	}
}

func (c *RelayClient) SendOutboundMail(req *models.OutboundSendRequest) (*models.OutboundSendResponse, error) {
	rawJSON, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal outbound mail: %w", err)
	}

	ciphertext, err := c.encryptor.Encrypt(rawJSON)
	if err != nil {
		return nil, fmt.Errorf("encryption error: %w", err)
	}

	envelope := models.EncryptedEnvelope{
		Type:      "mail_send",
		Payload:   ciphertext,
		Timestamp: time.Now(),
	}

	envelopeData, err := json.Marshal(envelope)
	if err != nil {
		return nil, err
	}

	targetURL := fmt.Sprintf("%s/api/send", c.cfg.SMTPServiceURL)
	httpReq, err := http.NewRequest(http.MethodPost, targetURL, bytes.NewBuffer(envelopeData))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+c.cfg.AuthToken)

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("failed to reach SMTP relay: %w", err)
	}
	defer resp.Body.Close()

	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("relay rejected mail (status %d): %s", resp.StatusCode, string(bodyBytes))
	}

	var sendResp models.OutboundSendResponse
	if err := json.Unmarshal(bodyBytes, &sendResp); err != nil {
		return nil, fmt.Errorf("invalid relay response: %w", err)
	}

	return &sendResp, nil
}

func (c *RelayClient) PushSyncState(domains []models.SyncDomain, aliases []models.SyncAlias) error {
	syncReq := models.SyncStateResponse{
		ServerTime: time.Now().Unix(),
		Domains:    domains,
		Aliases:    aliases,
	}

	rawJSON, err := json.Marshal(syncReq)
	if err != nil {
		return fmt.Errorf("failed to marshal sync payload: %w", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	targetURL := fmt.Sprintf("%s/api/domains/sync", c.cfg.SMTPServiceURL)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, targetURL, bytes.NewBuffer(rawJSON))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.cfg.AuthToken)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to reach SMTP service: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 1024*1024))
		return fmt.Errorf("SMTP sync rejected (status %d): %s", resp.StatusCode, string(bodyBytes))
	}

	return nil
}
