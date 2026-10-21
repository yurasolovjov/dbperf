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

	owned []uint32
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
			if err := m.Lease.Renew(ctx, m.Instance, m.owned); err != nil {
				m.Log.Warn("renew leases", "err", err)
			}
		case <-refresh.C:
			m.refresh(ctx)
		}
	}
}

func (m *Manager) refresh(ctx context.Context) {
	all, err := m.Source.List(ctx)
	if err != nil {
		m.Log.Error("list targets", "err", err)
		return
	}
	ids, err := m.Lease.Acquire(ctx, m.Instance, m.MaxTargets)
	if err != nil {
		m.Log.Error("acquire leases", "err", err)
		return
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	m.owned = ids
	own := make(map[uint32]bool, len(ids))
	for _, id := range ids {
		own[id] = true
	}
	desired := make([]Target, 0, len(ids))
	for _, t := range all {
		if own[t.ID] && t.Enabled {
			desired = append(desired, t)
		}
	}
	m.Log.Info("targets refreshed", "total", len(all), "owned", len(desired))
	m.Assignee.Apply(ctx, desired)
}
