package registry

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestYAMLSourceAndLocalLease(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "targets.yaml")
	data := `targets:
  - id: 2
    name: b
    dsn: postgres://x@h/b
    enabled: false
  - id: 1
    name: a
    dsn: postgres://x@h/a
    interval: 5s
  - id: 3
    name: c
    dsn: postgres://x@h/c
`
	if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
	src := &YAMLSource{Path: path, DefaultInterval: 10 * time.Second, DefaultTimeout: 5 * time.Second}
	targets, err := src.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(targets) != 3 || targets[0].ID != 1 || targets[0].Interval != 5*time.Second || targets[2].Interval != 10*time.Second {
		t.Fatalf("targets: %+v", targets)
	}
	if targets[1].Enabled {
		t.Fatal("target 2 must be disabled")
	}
	lease := NewLocalLease(src)
	ids, err := lease.Acquire(context.Background(), "me", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 2 || ids[0] != 1 || ids[1] != 3 {
		t.Fatalf("ids: %v", ids)
	}
	ids, _ = lease.Acquire(context.Background(), "me", 1)
	if len(ids) != 1 {
		t.Fatalf("want limit: %v", ids)
	}
}

func TestYAMLSourceRejectsDuplicates(t *testing.T) {
	path := filepath.Join(t.TempDir(), "t.yaml")
	_ = os.WriteFile(path, []byte("targets:\n  - {id: 1, name: a, dsn: d}\n  - {id: 1, name: b, dsn: d}\n"), 0o600)
	if _, err := (&YAMLSource{Path: path}).List(context.Background()); err == nil {
		t.Fatal("expected error")
	}
}

type fakeAssignee struct{ got [][]Target }

func (f *fakeAssignee) Apply(_ context.Context, t []Target) { f.got = append(f.got, t) }

func TestStatusStore(t *testing.T) {
	s := NewStatusStore()
	s.Set(Status{TargetID: 1, State: StateConnected})
	s.Update(2, func(st *Status) { st.State = StateDisconnected })
	c := s.Count()
	if c[StateConnected] != 1 || c[StateDisconnected] != 1 {
		t.Fatalf("count: %v", c)
	}
	s.Delete(1)
	if _, ok := s.Get(1); ok {
		t.Fatal("deleted")
	}
}
