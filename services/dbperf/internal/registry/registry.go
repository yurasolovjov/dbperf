// Package registry is layer 1: it knows which PostgreSQL databases are
// monitored and which instance of dbperf is responsible for each of them.
package registry

import (
	"context"
	"sync"
	"time"
)

// Target is one monitored PostgreSQL database.
type Target struct {
	ID               uint32
	Name             string
	DSN              string
	Interval         time.Duration
	StatementTimeout time.Duration
	Enabled          bool
}

// Equal reports whether two targets need the same scraper loop.
func (t Target) Equal(o Target) bool {
	return t.ID == o.ID && t.Name == o.Name && t.DSN == o.DSN &&
		t.Interval == o.Interval && t.StatementTimeout == o.StatementTimeout && t.Enabled == o.Enabled
}

// TargetSource lists targets.
type TargetSource interface {
	List(ctx context.Context) ([]Target, error)
}

// Lease assigns targets to instances. Acquire returns the ids this instance
// now owns (new and already owned), up to want in total.
type Lease interface {
	Acquire(ctx context.Context, instance string, want int) ([]uint32, error)
	Renew(ctx context.Context, instance string, ids []uint32) error
	Release(ctx context.Context, instance string) error
}

// State of a scraper connection.
type State int

const (
	StateUnknown State = iota
	StateConnected
	StateDisconnected
	StateDisabled
)

// Status is the live state of one target on this instance.
type Status struct {
	TargetID             uint32
	OwnerInstance        string
	State                State
	DisconnectedSince    time.Time
	LastSampleAt         time.Time
	LastError            string
	ServerVersionNum     int32
	LastSampleDurationMs int32
}

// StatusStore keeps the live status of targets owned by this instance.
type StatusStore struct {
	mu sync.RWMutex
	m  map[uint32]Status
}

// NewStatusStore creates an empty store.
func NewStatusStore() *StatusStore { return &StatusStore{m: map[uint32]Status{}} }

// Set replaces the status of a target.
func (s *StatusStore) Set(st Status) {
	s.mu.Lock()
	s.m[st.TargetID] = st
	s.mu.Unlock()
}

// Update applies fn to the current status of a target.
func (s *StatusStore) Update(id uint32, fn func(*Status)) {
	s.mu.Lock()
	st := s.m[id]
	st.TargetID = id
	fn(&st)
	s.m[id] = st
	s.mu.Unlock()
}

// Get returns the status of a target.
func (s *StatusStore) Get(id uint32) (Status, bool) {
	s.mu.RLock()
	st, ok := s.m[id]
	s.mu.RUnlock()
	return st, ok
}

// Delete forgets a target.
func (s *StatusStore) Delete(id uint32) {
	s.mu.Lock()
	delete(s.m, id)
	s.mu.Unlock()
}

// Count returns the number of targets per state.
func (s *StatusStore) Count() map[State]int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := map[State]int{}
	for _, st := range s.m {
		out[st.State]++
	}
	return out
}
