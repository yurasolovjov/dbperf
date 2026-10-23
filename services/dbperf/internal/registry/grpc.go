package registry

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"sync"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	registryv1 "github.com/yurasolovjov/dbperf/services/registry/gen/dbperf/registry/v1"
)

// GRPCRegistry is layer 1 over dbperf-registry: targets, session and leases.
// It implements TargetSource, Lease, Deadliner and OwnerLookup.
type GRPCRegistry struct {
	conn     *grpc.ClientConn
	targets  registryv1.TargetRegistryClient
	leases   registryv1.LeaseServiceClient
	instance string
	capacity int32
	version  string
	log      *slog.Logger

	mu       sync.Mutex
	session  string
	ttl      time.Duration
	renew    time.Duration
	deadline time.Time
	owned    map[uint32]struct{}
	cache    map[uint32]Target // targets received with assignments
}

// NewGRPCRegistry dials the registry and registers the instance.
func NewGRPCRegistry(ctx context.Context, addr, instance string, capacity int, version string, log *slog.Logger) (*GRPCRegistry, error) {
	conn, err := grpc.NewClient(addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return nil, fmt.Errorf("registry dial: %w", err)
	}
	r := &GRPCRegistry{
		conn: conn, targets: registryv1.NewTargetRegistryClient(conn), leases: registryv1.NewLeaseServiceClient(conn),
		instance: instance, capacity: int32(capacity), version: version, log: log,
		owned: map[uint32]struct{}{}, cache: map[uint32]Target{},
	}
	if err := r.register(ctx); err != nil {
		conn.Close()
		return nil, err
	}
	return r, nil
}

// Close closes the connection.
func (r *GRPCRegistry) Close() error { return r.conn.Close() }

// RenewInterval is the period recommended by the registry.
func (r *GRPCRegistry) RenewInterval() time.Duration {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.renew
}

// Deadline implements Deadliner.
func (r *GRPCRegistry) Deadline() time.Time {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.deadline
}

func (r *GRPCRegistry) register(ctx context.Context) error {
	resp, err := r.leases.RegisterInstance(ctx, &registryv1.RegisterInstanceRequest{Instance: r.instance, Capacity: r.capacity, Version: r.version})
	if err != nil {
		return fmt.Errorf("register instance: %w", err)
	}
	r.mu.Lock()
	r.session = resp.GetSessionId()
	r.ttl = time.Duration(resp.GetLeaseTtlSec()) * time.Second
	r.renew = time.Duration(resp.GetRenewIntervalSec()) * time.Second
	r.deadline = time.Now().Add(r.ttl)
	r.owned = map[uint32]struct{}{}
	r.mu.Unlock()
	r.log.Info("registered in registry", "session", resp.GetSessionId(), "ttl", r.ttl, "renew", r.renew, "fair_share", resp.GetFairShare())
	return nil
}

// sessionExpired reports whether the registry rejected the session.
func sessionExpired(err error) bool {
	return status.Code(err) == codes.Aborted || status.Code(err) == codes.PermissionDenied
}

// List implements TargetSource: every target, paged.
func (r *GRPCRegistry) List(ctx context.Context) ([]Target, error) {
	var out []Target
	var token string
	for {
		resp, err := r.targets.ListTargets(ctx, &registryv1.ListTargetsRequest{PageSize: 1000, PageToken: token})
		if err != nil {
			return nil, fmt.Errorf("list targets: %w", err)
		}
		for _, t := range resp.GetTargets() {
			out = append(out, fromProto(t))
		}
		if resp.GetNextPageToken() == "" {
			break
		}
		token = resp.GetNextPageToken()
	}
	r.mu.Lock()
	for _, t := range out {
		r.cache[t.ID] = t
	}
	r.mu.Unlock()
	return out, nil
}

// Acquire implements Lease: takes free targets up to want and returns all ids owned.
func (r *GRPCRegistry) Acquire(ctx context.Context, _ string, want int) ([]uint32, error) {
	r.mu.Lock()
	session := r.session
	ownedN := len(r.owned)
	r.mu.Unlock()
	if session == "" {
		if err := r.register(ctx); err != nil {
			return nil, err
		}
		r.mu.Lock()
		session = r.session
		r.mu.Unlock()
	}
	resp, err := r.leases.AcquireTargets(ctx, &registryv1.AcquireTargetsRequest{Instance: r.instance, SessionId: session, Want: int32(want - ownedN)})
	if err != nil {
		if sessionExpired(err) {
			r.expire()
			return nil, errors.New("registry session expired")
		}
		return nil, fmt.Errorf("acquire targets: %w", err)
	}
	r.mu.Lock()
	for _, a := range resp.GetAcquired() {
		r.owned[a.GetTargetId()] = struct{}{}
		if a.GetTarget() != nil {
			r.cache[a.GetTargetId()] = fromProto(a.GetTarget())
		}
	}
	r.deadline = time.Unix(resp.GetLeaseDeadlineUnix(), 0)
	ids := r.ownedIDs()
	r.mu.Unlock()
	if n := len(resp.GetAcquired()); n > 0 {
		r.log.Info("targets acquired", "n", n, "owned", len(ids), "fair_share", resp.GetFairShare())
	}
	return ids, nil
}

// Renew implements Lease: renews, drops lost targets, returns requested ones.
func (r *GRPCRegistry) Renew(ctx context.Context, _ string, ids []uint32) ([]uint32, error) {
	r.mu.Lock()
	session := r.session
	r.mu.Unlock()
	if session == "" {
		if err := r.register(ctx); err != nil {
			return nil, err
		}
		return nil, nil // nothing owned after a fresh registration
	}
	resp, err := r.leases.RenewLeases(ctx, &registryv1.RenewLeasesRequest{Instance: r.instance, SessionId: session, TargetIds: ids})
	if err != nil {
		if sessionExpired(err) {
			r.expire()
			return nil, errors.New("registry session expired")
		}
		return nil, fmt.Errorf("renew leases: %w", err)
	}
	if rel := resp.GetReleaseRequested(); len(rel) > 0 {
		if _, err := r.leases.ReleaseTargets(ctx, &registryv1.ReleaseTargetsRequest{Instance: r.instance, SessionId: session, TargetIds: rel}); err != nil {
			r.log.Warn("release requested targets", "err", err)
		} else {
			r.log.Info("released targets above fair share", "n", len(rel), "fair_share", resp.GetFairShare())
		}
	}
	drop := map[uint32]bool{}
	for _, id := range resp.GetReleaseRequested() {
		drop[id] = true
	}
	r.mu.Lock()
	r.owned = map[uint32]struct{}{}
	for _, id := range resp.GetRenewed() {
		if !drop[id] {
			r.owned[id] = struct{}{}
		}
	}
	r.deadline = time.Unix(resp.GetLeaseDeadlineUnix(), 0)
	owned := r.ownedIDs()
	r.mu.Unlock()
	if n := len(resp.GetLost()) + len(resp.GetNotOwnedSent()); n > 0 {
		r.log.Warn("targets lost on renew", "lost", resp.GetLost(), "unknown", resp.GetNotOwnedSent())
	}
	return owned, nil
}

// Release implements Lease: gives everything back on shutdown.
func (r *GRPCRegistry) Release(ctx context.Context, _ string) error {
	r.mu.Lock()
	session := r.session
	r.mu.Unlock()
	if session == "" {
		return nil
	}
	_, err := r.leases.ReleaseTargets(ctx, &registryv1.ReleaseTargetsRequest{Instance: r.instance, SessionId: session, All: true})
	return err
}

// Owner implements OwnerLookup.
func (r *GRPCRegistry) Owner(ctx context.Context, id uint32) (string, error) {
	resp, err := r.leases.ListAssignments(ctx, &registryv1.ListAssignmentsRequest{})
	if err != nil {
		return "", err
	}
	for _, in := range resp.GetInstances() {
		for _, t := range in.GetTargetIds() {
			if t == id {
				return in.GetInstance(), nil
			}
		}
	}
	return "", nil
}

func (r *GRPCRegistry) expire() {
	r.mu.Lock()
	r.session = ""
	r.owned = map[uint32]struct{}{}
	r.deadline = time.Time{}
	r.mu.Unlock()
	r.log.Warn("registry session expired, will re-register")
}

func (r *GRPCRegistry) ownedIDs() []uint32 {
	ids := make([]uint32, 0, len(r.owned))
	for id := range r.owned {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	return ids
}

func fromProto(t *registryv1.Target) Target {
	return Target{
		ID: t.GetTargetId(), Name: t.GetName(), DSN: t.GetDsn(),
		Interval:         time.Duration(t.GetIntervalSec()) * time.Second,
		StatementTimeout: time.Duration(t.GetStatementTimeoutMs()) * time.Millisecond,
		Enabled:          t.GetEnabled(),
	}
}
