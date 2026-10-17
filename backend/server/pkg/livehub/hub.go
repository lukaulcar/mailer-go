package livehub

import (
	"encoding/json"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"mailer-go/backend/shared/models"
)

type ClientFilter func(event *models.LiveEvent) bool

type Client struct {
	conn   *websocket.Conn
	send   chan []byte
	filter ClientFilter
}

type LiveHub struct {
	mu             sync.RWMutex
	clients        map[*Client]bool
	events         chan *models.LiveEvent
	register       chan *Client
	unregister     chan *Client
	allowedOrigins string
}

func (h *LiveHub) SetAllowedOrigins(origins string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.allowedOrigins = origins
}

func (h *LiveHub) checkOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	if strings.EqualFold(u.Host, r.Host) {
		return true
	}
	hostname := strings.ToLower(u.Hostname())
	if hostname == "localhost" || hostname == "127.0.0.1" || hostname == "::1" {
		return true
	}

	h.mu.RLock()
	allowed := strings.TrimSpace(h.allowedOrigins)
	h.mu.RUnlock()

	if allowed == "" {
		allowed = strings.TrimSpace(os.Getenv("CORS_ALLOWED_ORIGINS"))
	}
	if allowed == "*" || allowed == "" {
		return true
	}
	for _, o := range strings.Split(allowed, ",") {
		cleanO := strings.TrimSpace(o)
		if strings.EqualFold(cleanO, origin) {
			return true
		}
		if ou, err := url.Parse(cleanO); err == nil && strings.EqualFold(ou.Host, u.Host) {
			return true
		}
	}
	return false
}

func NewLiveHub() *LiveHub {
	h := &LiveHub{
		clients:        make(map[*Client]bool),
		events:         make(chan *models.LiveEvent, 512),
		register:       make(chan *Client, 128),
		unregister:     make(chan *Client, 128),
		allowedOrigins: os.Getenv("CORS_ALLOWED_ORIGINS"),
	}
	go h.run()
	return h
}

func (h *LiveHub) run() {
	for {
		select {
		case client := <-h.register:
			h.mu.Lock()
			h.clients[client] = true
			h.mu.Unlock()

		case client := <-h.unregister:
			h.mu.Lock()
			if _, ok := h.clients[client]; ok {
				delete(h.clients, client)
				close(client.send)
			}
			h.mu.Unlock()

		case event := <-h.events:
			data, err := json.Marshal(event)
			if err != nil {
				continue
			}
			h.mu.RLock()
			targets := make([]*Client, 0, len(h.clients))
			for client := range h.clients {
				targets = append(targets, client)
			}
			h.mu.RUnlock()

			var slowClients []*Client
			for _, client := range targets {
				if client.filter != nil && !client.filter(event) {
					continue
				}
				select {
				case client.send <- data:
				default:
					slowClients = append(slowClients, client)
				}
			}

			if len(slowClients) > 0 {
				h.mu.Lock()
				for _, client := range slowClients {
					if _, ok := h.clients[client]; ok {
						delete(h.clients, client)
						close(client.send)
					}
				}
				h.mu.Unlock()
			}
		}
	}
}

func (h *LiveHub) BroadcastEvent(event *models.LiveEvent) {
	if event.Timestamp == 0 {
		event.Timestamp = time.Now().Unix()
	}
	select {
	case h.events <- event:
	default:
		log.Printf("[LIVE HUB WARNING] Event queue full, dropping event")
	}
}

func (h *LiveHub) NotifyMailboxUsage(address string, usedBytes int64, usedMb float64) {
	h.BroadcastEvent(&models.LiveEvent{
		Type:      "mailbox_usage",
		Address:   address,
		UsedBytes: usedBytes,
		UsedMb:    usedMb,
		Timestamp: time.Now().Unix(),
	})
}

func (h *LiveHub) NotifyMessageReceived(mailbox string, msg *models.StoredMessage) {
	h.BroadcastEvent(&models.LiveEvent{
		Type:      "message_received",
		Address:   mailbox,
		Message:   msg,
		Timestamp: time.Now().Unix(),
	})
}

func (h *LiveHub) NotifyMessageDeleted(mailbox, messageID string) {
	h.BroadcastEvent(&models.LiveEvent{
		Type:      "message_deleted",
		Address:   mailbox,
		MessageID: messageID,
		Timestamp: time.Now().Unix(),
	})
}

func (h *LiveHub) NotifyMessagesCleared(mailbox, folder string) {
	h.BroadcastEvent(&models.LiveEvent{
		Type:      "messages_cleared",
		Address:   mailbox,
		Folder:    folder,
		Timestamp: time.Now().Unix(),
	})
}

func (h *LiveHub) NotifyMessagesDeleted(mailbox string, messageIDs []string) {
	h.BroadcastEvent(&models.LiveEvent{
		Type:       "messages_deleted",
		Address:    mailbox,
		MessageIDs: messageIDs,
		Timestamp:  time.Now().Unix(),
	})
}

func (h *LiveHub) HandleWSWithFilter(w http.ResponseWriter, r *http.Request, filter ClientFilter) {
	upgrader := websocket.Upgrader{
		CheckOrigin:     h.checkOrigin,
		ReadBufferSize:  1024,
		WriteBufferSize: 1024,
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[LIVE HUB] WebSocket upgrade error: %v", err)
		return
	}

	client := &Client{
		conn:   conn,
		send:   make(chan []byte, 64),
		filter: filter,
	}

	h.register <- client

	go func() {
		ticker := time.NewTicker(25 * time.Second)
		defer func() {
			ticker.Stop()
			_ = conn.Close()
		}()
		for {
			select {
			case message, ok := <-client.send:
				_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
				if !ok {
					_ = conn.WriteMessage(websocket.CloseMessage, []byte{})
					return
				}
				if err := conn.WriteMessage(websocket.TextMessage, message); err != nil {
					return
				}
			case <-ticker.C:
				_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
				if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
					return
				}
			}
		}
	}()

	go func() {
		defer func() {
			select {
			case h.unregister <- client:
			case <-time.After(500 * time.Millisecond):
			}
			_ = conn.Close()
		}()
		conn.SetReadLimit(512)
		_ = conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		conn.SetPongHandler(func(string) error {
			_ = conn.SetReadDeadline(time.Now().Add(60 * time.Second))
			return nil
		})
		for {
			_, _, err := conn.ReadMessage()
			if err != nil {
				break
			}
			_ = conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		}
	}()
}
