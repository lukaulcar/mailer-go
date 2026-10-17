package hub

import (
	"encoding/json"
	"log"
	"os"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"mailer-go/backend/shared/crypto"
	"mailer-go/backend/shared/models"
	"mailer-go/backend/smtp/pkg/spool"
)

type WSHub struct {
	mu           sync.RWMutex
	writeMu      sync.Mutex
	conn         *websocket.Conn
	encryptor    *crypto.Encryptor
	spool        *spool.SpoolManager
	isServerLive bool
	isDraining   int32
}

func NewWSHub(encryptor *crypto.Encryptor, spoolMgr *spool.SpoolManager) *WSHub {
	return &WSHub{
		encryptor: encryptor,
		spool:     spoolMgr,
	}
}

func (h *WSHub) Register(conn *websocket.Conn) {
	h.mu.Lock()
	if h.conn != nil {
		_ = h.conn.Close()
	}
	h.conn = conn
	h.isServerLive = true
	h.mu.Unlock()

	log.Println("[HUB] Backend server connected via WebSocket. Flushing queued mails...")

	go h.drainSpoolLoop()
}

func (h *WSHub) Unregister() {
	h.mu.Lock()
	defer h.mu.Unlock()

	if h.conn != nil {
		_ = h.conn.Close()
		h.conn = nil
	}
	h.isServerLive = false
	log.Println("[HUB] Backend server disconnected. Switching to spool mode (RAM/SQLite).")
}

func (h *WSHub) UnregisterConn(conn *websocket.Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if h.conn == conn {
		_ = h.conn.Close()
		h.conn = nil
		h.isServerLive = false
		log.Println("[HUB] Backend server disconnected. Switching to spool mode (RAM/SQLite).")
	}
}

func (h *WSHub) IsConnected() bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.isServerLive
}

func (h *WSHub) DispatchIncomingMail(msg *models.MailMessage) error {
	if h.IsConnected() {
		if err := h.sendEncryptedMail(msg); err == nil {
			log.Printf("[HUB] Dispatched mail %s directly to live backend server.", msg.ID)
			return nil
		}
		log.Printf("[HUB] Failed sending live mail %s over WebSocket. Spooling...", msg.ID)
		h.Unregister()
	}

	_, err := h.spool.Enqueue(msg)
	return err
}

func (h *WSHub) sendEncryptedMail(msg *models.MailMessage) error {
	rawJSON, err := json.Marshal(msg)
	if err != nil {
		return err
	}

	ciphertext, err := h.encryptor.Encrypt(rawJSON)
	if err != nil {
		return err
	}

	envelope := models.EncryptedEnvelope{
		Type:      "mail_received",
		Payload:   ciphertext,
		Timestamp: time.Now(),
	}

	data, err := json.Marshal(envelope)
	if err != nil {
		return err
	}

	h.mu.RLock()
	conn := h.conn
	isLive := h.isServerLive
	h.mu.RUnlock()

	if !isLive || conn == nil {
		return websocket.ErrCloseSent
	}

	h.writeMu.Lock()
	defer h.writeMu.Unlock()

	writeTimeout := 30 * time.Second
	if val := os.Getenv("WS_WRITE_TIMEOUT_SEC"); val != "" {
		if n, err := strconv.Atoi(val); err == nil && n > 0 {
			writeTimeout = time.Duration(n) * time.Second
		}
	}
	_ = conn.SetWriteDeadline(time.Now().Add(writeTimeout))
	return conn.WriteMessage(websocket.TextMessage, data)
}

func (h *WSHub) drainSpoolLoop() {
	if !atomic.CompareAndSwapInt32(&h.isDraining, 0, 1) {
		return
	}
	defer atomic.StoreInt32(&h.isDraining, 0)

	for {
		if !h.IsConnected() {
			return
		}

		batch, err := h.spool.DequeueBatch(20)
		if err != nil || len(batch) == 0 {
			break
		}

		for i, msg := range batch {
			if !h.IsConnected() {
				h.requeue(batch[i:])
				return
			}

			if err := h.sendEncryptedMail(msg); err != nil {
				log.Printf("[HUB] Drain send failed for mail %s. Re-spooling remaining...", msg.ID)
				h.requeue(batch[i:])
				h.Unregister()
				return
			}
			log.Printf("[HUB] Drained spooled mail %s to backend server.", msg.ID)
		}
	}
}

func (h *WSHub) requeue(msgs []*models.MailMessage) {
	for _, msg := range msgs {
		if _, err := h.spool.Enqueue(msg); err != nil {
			log.Printf("[HUB ALERT] Failed to re-spool mail %s after drain error: %v - MESSAGE LOST", msg.ID, err)
		}
	}
}
