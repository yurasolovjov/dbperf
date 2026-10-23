package registry

import (
	"context"
	"log/slog"
	"sort"
	"time"
)

// Assignee receives the desired set of targets after every refresh.
type Assignee interface {
	Apply(ctx context.Context, targets []Target)
}

// Manager periodically lists targets, holds leases and hands the owned
// subset to the scraper.
type Manager struct {
	Source     TargetSource
	Lease      Lease
	Instance   string
	MaxTargets int
	Refresh    time.Duration
	Renew      time.Duration
	Assignee   Assignee
	Log        *slog.Logger

	owned   []uint32
	all     []Target
	stopped bool // lease deadline passed: every loop stopped until reacquired
}

// Run blocks until ctx is cancelled, then releases the leases.
func (m *Manager) Run(ctx context.Context) error {
	m.refresh(ctx)
	refresh := time.NewTicker(m.Refresh)
	renew := time.NewTicker(m.Renew)
	defer refresh.Stop()
	defer renew.Stop()
	for {
		select {
		case <-ctx.Done():
			rctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := m.Lease.Release(rctx, m.Instance); err != nil {
				m.Log.Warn("release leases", "err", err)
			}
			return ctx.Err()
		case <-renew.C:
			m.renew(ctx)
		case <-refresh.C:
			m.refresh(ctx)
		}
	}
}

// renew confirms the owned set; targets the lease no longer confirms stop at
// once. When the lease has a deadline and renewing failed past it, every
// loop stops: another instance may own the targets by now.
func (m *Manager) renew(ctx context.Context) {
	owned, err := m.Lease.Renew(ctx, m.Instance, m.owned)
	if err != nil {
		m.Log.Warn("renew leases", "err", err)
		m.checkDeadline(ctx)
		return
	}
	sort.Slice(owned, func(i, j int) bool { return owned[i] < owned[j] })
	changed := !equalIDs(owned, m.owned) || m.stopped
	m.owned = owned
	m.stopped = false
	if changed {
		m.Log.Info("owned set changed on renew", "owned", len(owned))
		m.apply(ctx)
	}
}

func (m *Manager) checkDeadline(ctx context.Context) {
	d, ok := m.Lease.(Deadliner)
	if !ok || m.stopped || d.Deadline().IsZero() || time.Now().Before(d.Deadline()) {
		return
	}
	m.Log.Error("lease deadline passed without renewal, stopping all targets", "deadline", d.Deadline())
	m.owned = nil
	m.stopped = true
	m.apply(ctx)
}

func (m *Manager) refresh(ctx context.Context) {
	all, err := m.Source.List(ctx)
	if err != nil {
		m.Log.Error("list targets", "err", err)
		m.checkDeadline(ctx)
		return
	}
	m.all = all
	ids, err := m.Lease.Acquire(ctx, m.Instance, m.MaxTargets)
	if err != nil {
		m.Log.Error("acquire leases", "err", err)
		m.checkDeadline(ctx)
		return
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	m.owned = ids
	m.stopped = false
	m.apply(ctx)
}

// apply hands the owned, enabled targets to the scraper.
func (m *Manager) apply(ctx context.Context) {
	own := make(map[uint32]bool, len(m.owned))
	for _, id := range m.owned {
		own[id] = true
	}
	desired := make([]Target, 0, len(m.owned))
	for _, t := range m.all {
		if own[t.ID] && t.Enabled {
			desired = append(desired, t)
		}
	}
	m.Log.Info("targets applied", "total", len(m.all), "owned", len(desired))
	m.Assignee.Apply(ctx, desired)
}

func equalIDs(a, b []uint32) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
