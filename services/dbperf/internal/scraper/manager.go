package scraper

import (
	"context"
	"log/slog"
	"sync"

	"github.com/yurasolovjov/dbperf/services/dbperf/internal/config"
	"github.com/yurasolovjov/dbperf/services/dbperf/internal/registry"
)

// Manager keeps one Loop per assigned target. It implements registry.Assignee.
type Manager struct {
	cfg     config.Scraper
	emit    Emitter
	status  *registry.StatusStore
	metrics Metrics
	log     *slog.Logger

	mu    sync.Mutex
	loops map[uint32]*Loop
	ctx   context.Context
}

// NewManager creates a manager; loops are started with the context of Run.
func NewManager(cfg config.Scraper, emit Emitter, status *registry.StatusStore, m Metrics, log *slog.Logger) *Manager {
	return &Manager{cfg: cfg, emit: emit, status: status, metrics: m, log: log, loops: map[uint32]*Loop{}}
}

// Run blocks until ctx is cancelled and stops every loop.
func (m *Manager) Run(ctx context.Context) error {
	m.mu.Lock()
	m.ctx = ctx
	m.mu.Unlock()
	<-ctx.Done()
	m.mu.Lock()
	loops := m.loops
	m.loops = map[uint32]*Loop{}
	m.mu.Unlock()
	var wg sync.WaitGroup
	for _, l := range loops {
		wg.Add(1)
		go func(l *Loop) { defer wg.Done(); l.stop() }(l)
	}
	wg.Wait()
	return ctx.Err()
}

// Apply starts loops for new targets, stops loops for removed ones and
// restarts loops whose target definition changed.
func (m *Manager) Apply(_ context.Context, targets []registry.Target) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.ctx == nil || m.ctx.Err() != nil {
		return
	}
	desired := make(map[uint32]registry.Target, len(targets))
	for _, t := range targets {
		if t.Interval <= 0 {
			t.Interval = m.cfg.DefaultInterval
		}
		if t.StatementTimeout <= 0 {
			t.StatementTimeout = m.cfg.StatementTimeout
		}
		desired[t.ID] = t
	}
	for id, l := range m.loops {
		t, ok := desired[id]
		if ok && t.Equal(l.target) {
			continue
		}
		l.stop()
		delete(m.loops, id)
		m.status.Delete(id)
		if !ok {
			m.log.Info("target removed", "target_id", id)
		}
	}
	for id, t := range desired {
		if _, ok := m.loops[id]; ok {
			continue
		}
		l := newLoop(t, m.cfg, m.emit, m.status, m.metrics, m.log)
		m.status.Set(registry.Status{TargetID: id, State: registry.StateDisconnected})
		l.start(m.ctx)
		m.loops[id] = l
		m.log.Info("target started", "target_id", id, "name", t.Name, "interval", t.Interval)
	}
}

// Len returns the number of running loops.
func (m *Manager) Len() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.loops)
}
