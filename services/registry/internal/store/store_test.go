package store

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"
)

// Integration tests need a real etcd: ETCD_ENDPOINTS=localhost:12379 go test ./internal/store/
func newStore(t *testing.T) *Store {
	t.Helper()
	ep := os.Getenv("ETCD_ENDPOINTS")
	if ep == "" {
		t.Skip("ETCD_ENDPOINTS not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	s, err := New(ctx, []string{ep}, fmt.Sprintf("/test-%d/", time.Now().UnixNano()), 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func TestCreateUniqueNameUnderRace(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	var wg sync.WaitGroup
	results := make([]error, 8)
	for i := range results {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, results[i] = s.Create(ctx, Target{Name: "same", DSN: "postgres://u@h/db", IntervalSec: 10, Enabled: true})
		}(i)
	}
	wg.Wait()
	ok, dup := 0, 0
	for _, err := range results {
		switch {
		case err == nil:
			ok++
		case errors.Is(err, ErrAlreadyExists):
			dup++
		default:
			t.Fatalf("unexpected error: %v", err)
		}
	}
	if ok != 1 || dup != 7 {
		t.Fatalf("ok=%d dup=%d", ok, dup)
	}
	all, _, err := s.List(ctx)
	if err != nil || len(all) != 1 || all[0].ID != 1 {
		t.Fatalf("list: %v %+v", err, all)
	}
}

func TestUpdateRevisionAndRename(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	a, _ := s.Create(ctx, Target{Name: "a", DSN: "postgres://u@h/a", IntervalSec: 10, Enabled: true})
	b, _ := s.Create(ctx, Target{Name: "b", DSN: "postgres://u@h/b", IntervalSec: 10, Enabled: true})
	a.Name = "b"
	if _, err := s.Update(ctx, a, 0); !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("rename to a taken name: %v", err)
	}
	a.Name = "a2"
	a2, err := s.Update(ctx, a, a.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Update(ctx, a2, a.Revision); !errors.Is(err, ErrRevision) {
		t.Fatalf("stale revision must fail: %v", err)
	}
	if got, err := s.GetByName(ctx, "a2"); err != nil || got.ID != a.ID {
		t.Fatalf("rename lookup: %v %+v", err, got)
	}
	if _, err := s.GetByName(ctx, "a"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("old name must be gone: %v", err)
	}
	if err := s.Delete(ctx, b.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Get(ctx, b.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted target still readable: %v", err)
	}
}

func TestLeasesAreExclusiveAndExpire(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	var ids []uint32
	for i := 0; i < 6; i++ {
		tg, err := s.Create(ctx, Target{Name: fmt.Sprintf("t%d", i), DSN: "postgres://u@h/db", IntervalSec: 10, Enabled: true})
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, tg.ID)
	}
	ttl := 2 * time.Second
	i1, err := s.Register(ctx, Instance{Name: "i1", Capacity: 10}, ttl)
	if err != nil {
		t.Fatal(err)
	}
	i2, err := s.Register(ctx, Instance{Name: "i2", Capacity: 10}, ttl)
	if err != nil {
		t.Fatal(err)
	}
	// both try the same ids: every id ends up with exactly one owner
	var wg sync.WaitGroup
	var got1, got2 []uint32
	wg.Add(2)
	go func() { defer wg.Done(); got1, _ = s.Acquire(ctx, "i1", i1.LeaseID, ids) }()
	go func() { defer wg.Done(); got2, _ = s.Acquire(ctx, "i2", i2.LeaseID, ids) }()
	wg.Wait()
	if len(got1)+len(got2) != len(ids) {
		t.Fatalf("exclusive: %v %v", got1, got2)
	}
	owners, _ := s.Owners(ctx)
	if len(owners) != len(ids) {
		t.Fatalf("owners: %v", owners)
	}
	// release by the wrong instance does nothing
	if n, _ := s.Release(ctx, "i2", got1); n != 0 {
		t.Fatalf("release by non-owner released %d", n)
	}
	// keepalive keeps i1 alive while i2 expires
	deadline := time.Now().Add(ttl + 2*time.Second)
	for time.Now().Before(deadline) {
		if _, err := s.KeepAlive(ctx, i1.LeaseID); err != nil {
			t.Fatal(err)
		}
		time.Sleep(500 * time.Millisecond)
	}
	owners, _ = s.Owners(ctx)
	for id, o := range owners {
		if o.Instance == "i2" {
			t.Fatalf("i2 lease should have expired, still owns %d", id)
		}
	}
	if len(owners) != len(got1) {
		t.Fatalf("i1 should keep %d targets, owners=%v", len(got1), owners)
	}
	if err := s.CheckSession(ctx, "i2", i2.LeaseID); !errors.Is(err, ErrSession) {
		t.Fatalf("expired session must be rejected: %v", err)
	}
	// a re-registered instance gets a fresh session and the freed targets
	i2b, err := s.Register(ctx, Instance{Name: "i2", Capacity: 10}, ttl)
	if err != nil || i2b.LeaseID == i2.LeaseID {
		t.Fatalf("re-register: %v", err)
	}
	taken, _ := s.Acquire(ctx, "i2", i2b.LeaseID, ids)
	if len(taken) != len(got2) {
		t.Fatalf("i2 should retake %d, got %d", len(got2), len(taken))
	}
	// disabling a target drops its owner
	tg, _ := s.Get(ctx, got1[0])
	tg.Enabled = false
	if _, err := s.Update(ctx, tg, 0); err != nil {
		t.Fatal(err)
	}
	owners, _ = s.Owners(ctx)
	if _, still := owners[got1[0]]; still {
		t.Fatal("disabled target must lose its owner")
	}
	_ = s.Revoke(ctx, i1.LeaseID)
	owners, _ = s.Owners(ctx)
	for _, o := range owners {
		if o.Instance == "i1" {
			t.Fatal("revoke must free every target of i1")
		}
	}
}

func TestWatch(t *testing.T) {
	s := newStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, rev, _ := s.List(ctx)
	ch := s.Watch(ctx, rev)
	tg, _ := s.Create(ctx, Target{Name: "w", DSN: "postgres://u@h/db", IntervalSec: 10, Enabled: true})
	_ = s.Delete(ctx, tg.ID)
	ev := <-ch
	if ev.Deleted || ev.ID != tg.ID || ev.Target.Name != "w" {
		t.Fatalf("put event: %+v", ev)
	}
	ev = <-ch
	if !ev.Deleted || ev.ID != tg.ID {
		t.Fatalf("delete event: %+v", ev)
	}
}

func TestExplicitIDsDoNotCollideWithAllocated(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	if _, err := s.Create(ctx, Target{ID: 1, Name: "imported1", DSN: "postgres://u@h/db", IntervalSec: 10, Enabled: true}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Create(ctx, Target{ID: 5, Name: "imported5", DSN: "postgres://u@h/db", IntervalSec: 10, Enabled: true}); err != nil {
		t.Fatal(err)
	}
	got, err := s.Create(ctx, Target{Name: "auto", DSN: "postgres://u@h/db", IntervalSec: 10, Enabled: true})
	if err != nil {
		t.Fatalf("auto id after imports: %v", err)
	}
	if got.ID != 6 {
		t.Fatalf("expected id 6 after imported 5, got %d", got.ID)
	}
	if _, err := s.Create(ctx, Target{ID: 5, Name: "other", DSN: "postgres://u@h/db", IntervalSec: 10, Enabled: true}); !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("taken explicit id: %v", err)
	}
	if _, err := s.Create(ctx, Target{Name: "auto", DSN: "postgres://u@h/db", IntervalSec: 10, Enabled: true}); !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("taken name: %v", err)
	}
}
