// Package console buffers per-server log output and fans it out to Server-Sent
// Events subscribers, and broadcasts host-wide events (status changes).
package console

import (
	"sync"
	"time"
)

const maxBuffer = 2000

// LogEntry is a single line of server output (or a provisioning message).
type LogEntry struct {
	ServerID  string `json:"serverId"`
	Line      string `json:"line"`
	Timestamp int64  `json:"timestamp"`
	Level     string `json:"level,omitempty"`
}

// Event is a host-wide event delivered on the /v1/events stream.
type Event struct {
	Type     string `json:"type"` // e.g. "status"
	ServerID string `json:"serverId"`
	Status   string `json:"status,omitempty"`
}

// Hub coordinates log buffers and subscribers.
type Hub struct {
	mu        sync.Mutex
	buffers   map[string][]LogEntry
	logSubs   map[string]map[chan LogEntry]struct{}
	eventSubs map[chan Event]struct{}
}

// New creates an empty Hub.
func New() *Hub {
	return &Hub{
		buffers:   map[string][]LogEntry{},
		logSubs:   map[string]map[chan LogEntry]struct{}{},
		eventSubs: map[chan Event]struct{}{},
	}
}

// PushLog appends a line to a server's buffer and delivers it to subscribers.
func (h *Hub) PushLog(serverID, line, level string) {
	entry := LogEntry{ServerID: serverID, Line: line, Timestamp: time.Now().UnixMilli(), Level: level}

	h.mu.Lock()
	buf := append(h.buffers[serverID], entry)
	if len(buf) > maxBuffer {
		buf = buf[len(buf)-maxBuffer:]
	}
	h.buffers[serverID] = buf

	subs := make([]chan LogEntry, 0, len(h.logSubs[serverID]))
	for ch := range h.logSubs[serverID] {
		subs = append(subs, ch)
	}
	h.mu.Unlock()

	for _, ch := range subs {
		select {
		case ch <- entry:
		default: // slow consumer: drop rather than block the producer
		}
	}
}

// Buffer returns a copy of a server's buffered log history.
func (h *Hub) Buffer(serverID string) []LogEntry {
	h.mu.Lock()
	defer h.mu.Unlock()
	src := h.buffers[serverID]
	out := make([]LogEntry, len(src))
	copy(out, src)
	return out
}

// ClearBuffer drops a server's buffered history (e.g. on delete).
func (h *Hub) ClearBuffer(serverID string) {
	h.mu.Lock()
	delete(h.buffers, serverID)
	h.mu.Unlock()
}

// SubscribeLogs registers a subscriber for a server's live log lines.
func (h *Hub) SubscribeLogs(serverID string) (<-chan LogEntry, func()) {
	ch := make(chan LogEntry, 256)
	h.mu.Lock()
	if h.logSubs[serverID] == nil {
		h.logSubs[serverID] = map[chan LogEntry]struct{}{}
	}
	h.logSubs[serverID][ch] = struct{}{}
	h.mu.Unlock()

	cancel := func() {
		h.mu.Lock()
		if subs := h.logSubs[serverID]; subs != nil {
			delete(subs, ch)
			if len(subs) == 0 {
				delete(h.logSubs, serverID)
			}
		}
		h.mu.Unlock()
		close(ch)
	}
	return ch, cancel
}

// BroadcastEvent delivers a host-wide event to all event subscribers.
func (h *Hub) BroadcastEvent(e Event) {
	h.mu.Lock()
	subs := make([]chan Event, 0, len(h.eventSubs))
	for ch := range h.eventSubs {
		subs = append(subs, ch)
	}
	h.mu.Unlock()

	for _, ch := range subs {
		select {
		case ch <- e:
		default:
		}
	}
}

// SubscribeEvents registers a subscriber for host-wide events.
func (h *Hub) SubscribeEvents() (<-chan Event, func()) {
	ch := make(chan Event, 64)
	h.mu.Lock()
	h.eventSubs[ch] = struct{}{}
	h.mu.Unlock()

	cancel := func() {
		h.mu.Lock()
		delete(h.eventSubs, ch)
		h.mu.Unlock()
		close(ch)
	}
	return ch, cancel
}
