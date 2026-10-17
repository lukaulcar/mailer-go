package api

import (
	"sync"
	"time"
)

type ipLimiter struct {
	mu     sync.Mutex
	counts map[string]*limitWindow
	limit  int
	window time.Duration
}

type limitWindow struct {
	start time.Time
	count int
}

func newIPLimiter(limit int, window time.Duration) *ipLimiter {
	return &ipLimiter{
		counts: make(map[string]*limitWindow),
		limit:  limit,
		window: window,
	}
}

func (l *ipLimiter) allow(key string) bool {
	if l == nil || l.limit <= 0 {
		return true
	}
	now := time.Now()

	l.mu.Lock()
	defer l.mu.Unlock()

	w, ok := l.counts[key]
	if !ok || now.Sub(w.start) >= l.window {
		l.counts[key] = &limitWindow{start: now, count: 1}
		if len(l.counts) > 10000 {
			for k, v := range l.counts {
				if now.Sub(v.start) >= l.window {
					delete(l.counts, k)
				}
			}
		}
		return true
	}

	w.count++
	return w.count <= l.limit
}
