package grpc

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"testing"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/fieldmaskpb"

	registryv1 "github.com/yurasolovjov/dbperf/services/registry/gen/dbperf/registry/v1"
	"github.com/yurasolovjov/dbperf/services/registry/internal/store"
)

type nopMetrics struct{}

func (nopMetrics) TargetsChanged()         {}
func (nopMetrics) LeaseCall(string, error) {}
func (nopMetrics) SetInstances(int)        {}

// Integration test: ETCD_ENDPOINTS=localhost:12379 go test ./internal/api/grpc/
func newServers(t *testing.T, ttl time.Duration) (*TargetServer, *LeaseServer) {
	t.Helper()
	ep := os.Getenv("ETCD_ENDPOINTS")
	if ep == "" {
		t.Skip("ETCD_ENDPOINTS not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	st, err := store.New(ctx, []string{ep}, fmt.Sprintf("/test-%d/", time.Now().UnixNano()), 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))
	return NewTargetServer(st, nopMetrics{}, log), NewLeaseServer(st, ttl, ttl/3, nopMetrics{}, log)
}

type inst struct {
	name    string
	session string
	owned   []uint32
}

func (i *inst) acquire(t *testing.T, ls *LeaseServer, want int32) {
	t.Helper()
	resp, err := ls.AcquireTargets(context.Background(), &registryv1.AcquireTargetsRequest{Instance: i.name, SessionId: i.session, Want: want})
	if err != nil {
		t.Fatal(err)
	}
	for _, a := range resp.GetAcquired() {
		i.owned = append(i.owned, a.GetTargetId())
	}
}

func (i *inst) renew(t *testing.T, ls *LeaseServer) *registryv1.RenewLeasesResponse {
	t.Helper()
	resp, err := ls.RenewLeases(context.Background(), &registryv1.RenewLeasesRequest{Instance: i.name, SessionId: i.session, TargetIds: i.owned})
	if err != nil {
		t.Fatal(err)
	}
	i.owned = resp.GetRenewed()
	if len(resp.GetReleaseRequested()) > 0 {
		_, err := ls.ReleaseTargets(context.Background(), &registryv1.ReleaseTargetsRequest{Instance: i.name, SessionId: i.session, TargetIds: resp.GetReleaseRequested()})
		if err != nil {
			t.Fatal(err)
		}
		rel := map[uint32]bool{}
		for _, id := range resp.GetReleaseRequested() {
			rel[id] = true
		}
		kept := i.owned[:0]
		for _, id := range i.owned {
			if !rel[id] {
				kept = append(kept, id)
			}
		}
		i.owned = kept
	}
	return resp
}

func register(t *testing.T, ls *LeaseServer, name string, capacity int32) *inst {
	t.Helper()
	resp, err := ls.RegisterInstance(context.Background(), &registryv1.RegisterInstanceRequest{Instance: name, Capacity: capacity, Version: "test"})
	if err != nil {
		t.Fatal(err)
	}
	return &inst{name: name, session: resp.GetSessionId()}
}

func TestFairDistributionFailoverAndRebalance(t *testing.T) {
	ts, ls := newServers(t, 3*time.Second)
	ctx := context.Background()
	const n = 30
	for i := 0; i < n; i++ {
		if _, err := ts.CreateTarget(ctx, &registryv1.CreateTargetRequest{Name: fmt.Sprintf("db%02d", i), Dsn: "postgres://u@h/db"}); err != nil {
			t.Fatal(err)
		}
	}
	// three instances register first, then acquire: each gets fair share 10
	a, b, c := register(t, ls, "a", 100), register(t, ls, "b", 100), register(t, ls, "c", 100)
	for _, in := range []*inst{a, b, c} {
		in.acquire(t, ls, 100)
	}
	if len(a.owned) != 10 || len(b.owned) != 10 || len(c.owned) != 10 {
		t.Fatalf("even split expected: %d %d %d", len(a.owned), len(b.owned), len(c.owned))
	}
	// c dies: nobody renews its session; a and b keep renewing
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		a.renew(t, ls)
		b.renew(t, ls)
		time.Sleep(500 * time.Millisecond)
	}
	ra := a.renew(t, ls)
	if ra.GetFairShare() != 15 {
		t.Fatalf("fair share after failover: %d", ra.GetFairShare())
	}
	a.acquire(t, ls, 100)
	b.acquire(t, ls, 100)
	if len(a.owned)+len(b.owned) != n || len(a.owned) != 15 || len(b.owned) != 15 {
		t.Fatalf("after failover: a=%d b=%d", len(a.owned), len(b.owned))
	}
	if _, err := ls.RenewLeases(ctx, &registryv1.RenewLeasesRequest{Instance: "c", SessionId: c.session, TargetIds: c.owned}); status.Code(err) != codes.Aborted {
		t.Fatalf("expired session must be ABORTED, got %v", err)
	}
	// c comes back: fair share drops to 10, a and b release 10% per renew, c picks them up
	c = register(t, ls, "c", 100)
	for round := 0; round < 40 && len(c.owned) < 10; round++ {
		a.renew(t, ls)
		b.renew(t, ls)
		c.renew(t, ls)
		c.acquire(t, ls, 100)
	}
	if len(a.owned) != 10 || len(b.owned) != 10 || len(c.owned) != 10 {
		t.Fatalf("after rebalance: a=%d b=%d c=%d", len(a.owned), len(b.owned), len(c.owned))
	}
	// no target has two owners, none is unassigned
	as, err := ls.ListAssignments(ctx, &registryv1.ListAssignmentsRequest{})
	if err != nil {
		t.Fatal(err)
	}
	seen := map[uint32]string{}
	for _, in := range as.GetInstances() {
		for _, id := range in.GetTargetIds() {
			if prev, dup := seen[id]; dup {
				t.Fatalf("target %d owned by %s and %s", id, prev, in.GetInstance())
			}
			seen[id] = in.GetInstance()
		}
	}
	if len(seen) != n || len(as.GetUnassigned()) != 0 {
		t.Fatalf("assignments: %d owned, unassigned %v", len(seen), as.GetUnassigned())
	}
	// disabling a target reports it as lost on the next renew
	victim := a.owned[0]
	if _, err := ts.UpdateTarget(ctx, &registryv1.UpdateTargetRequest{Target: &registryv1.Target{TargetId: victim, Enabled: false}, UpdateMask: mask("enabled")}); err != nil {
		t.Fatal(err)
	}
	before := append([]uint32(nil), a.owned...)
	r := a.renew(t, ls)
	if len(r.GetLost()) != 1 || r.GetLost()[0] != victim || len(a.owned) != len(before)-1 {
		t.Fatalf("lost: %v owned %d", r.GetLost(), len(a.owned))
	}
	// unknown id is reported separately
	r2, err := ls.RenewLeases(ctx, &registryv1.RenewLeasesRequest{Instance: a.name, SessionId: a.session, TargetIds: append(a.owned, 9999)})
	if err != nil || len(r2.GetNotOwnedSent()) != 1 {
		t.Fatalf("not_owned_sent: %v %v", err, r2.GetNotOwnedSent())
	}
	// graceful release frees everything
	if _, err := ls.ReleaseTargets(ctx, &registryv1.ReleaseTargetsRequest{Instance: b.name, SessionId: b.session, All: true}); err != nil {
		t.Fatal(err)
	}
	as, _ = ls.ListAssignments(ctx, &registryv1.ListAssignmentsRequest{Instance: "b"})
	if len(as.GetInstances()) != 1 || len(as.GetInstances()[0].GetTargetIds()) != 0 {
		t.Fatalf("b should own nothing: %v", as.GetInstances())
	}
}

func mask(paths ...string) *fieldmaskpb.FieldMask { return &fieldmaskpb.FieldMask{Paths: paths} }
