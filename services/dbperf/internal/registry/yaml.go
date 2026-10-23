package registry

import (
	"context"
	"fmt"
	"os"
	"sort"
	"sync"
	"time"

	"gopkg.in/yaml.v3"
)

type yamlFile struct {
	Targets []yamlTarget `yaml:"targets"`
}

type yamlTarget struct {
	ID               uint32        `yaml:"id"`
	Name             string        `yaml:"name"`
	DSN              string        `yaml:"dsn"`
	Interval         time.Duration `yaml:"interval"`
	StatementTimeout time.Duration `yaml:"statement_timeout"`
	Enabled          *bool         `yaml:"enabled"`
}

// YAMLSource reads targets from a YAML file on every List call, so edits are
// picked up without a restart.
type YAMLSource struct {
	Path            string
	DefaultInterval time.Duration
	DefaultTimeout  time.Duration
}

// List implements TargetSource.
func (s *YAMLSource) List(_ context.Context) ([]Target, error) {
	data, err := os.ReadFile(s.Path)
	if err != nil {
		return nil, fmt.Errorf("read targets: %w", err)
	}
	var f yamlFile
	if err := yaml.Unmarshal(data, &f); err != nil {
		return nil, fmt.Errorf("parse targets: %w", err)
	}
	out := make([]Target, 0, len(f.Targets))
	seen := map[uint32]bool{}
	for _, y := range f.Targets {
		if y.ID == 0 || y.Name == "" || y.DSN == "" {
			return nil, fmt.Errorf("target %q: id, name and dsn are required", y.Name)
		}
		if seen[y.ID] {
			return nil, fmt.Errorf("target id %d is duplicated", y.ID)
		}
		seen[y.ID] = true
		t := Target{
			ID:               y.ID,
			Name:             y.Name,
			DSN:              y.DSN,
			Interval:         y.Interval,
			StatementTimeout: y.StatementTimeout,
			Enabled:          y.Enabled == nil || *y.Enabled,
		}
		if t.Interval == 0 {
			t.Interval = s.DefaultInterval
		}
		if t.StatementTimeout == 0 {
			t.StatementTimeout = s.DefaultTimeout
		}
		out = append(out, t)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

// LocalLease is a Lease for a single instance: it owns every target it is
// asked for. Used with the YAML source on a test bench.
type LocalLease struct {
	mu     sync.Mutex
	source TargetSource
}

// NewLocalLease creates a lease that grants all targets of the source.
func NewLocalLease(src TargetSource) *LocalLease { return &LocalLease{source: src} }

// Acquire implements Lease.
func (l *LocalLease) Acquire(ctx context.Context, _ string, want int) ([]uint32, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	targets, err := l.source.List(ctx)
	if err != nil {
		return nil, err
	}
	ids := make([]uint32, 0, len(targets))
	for _, t := range targets {
		if !t.Enabled {
			continue
		}
		if len(ids) >= want {
			break
		}
		ids = append(ids, t.ID)
	}
	return ids, nil
}

// Renew implements Lease: a local lease never loses targets.
func (l *LocalLease) Renew(_ context.Context, _ string, ids []uint32) ([]uint32, error) {
	return ids, nil
}

// Release implements Lease.
func (l *LocalLease) Release(context.Context, string) error { return nil }
