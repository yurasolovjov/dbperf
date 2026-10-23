package grpc

import (
	"context"
	"log/slog"
	"sort"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	registryv1 "github.com/yurasolovjov/dbperf/services/registry/gen/dbperf/registry/v1"
	"github.com/yurasolovjov/dbperf/services/registry/internal/lease"
	"github.com/yurasolovjov/dbperf/services/registry/internal/store"
)

// Metrics is what the servers report.
type Metrics interface {
	TargetsChanged()
	LeaseCall(method string, err error)
	SetInstances(n int)
}

// LeaseServer implements LeaseService.
type LeaseServer struct {
	registryv1.UnimplementedLeaseServiceServer
	store   *store.Store
	ttl     time.Duration
	renew   time.Duration
	log     *slog.Logger
	metrics Metrics
}

// NewLeaseServer creates the service with the lease TTL and renew period.
func NewLeaseServer(st *store.Store, ttl, renew time.Duration, m Metrics, log *slog.Logger) *LeaseServer {
	return &LeaseServer{store: st, ttl: ttl, renew: renew, metrics: m, log: log}
}

// cluster is a consistent snapshot of targets, owners and instances.
type cluster struct {
	targets   map[uint32]store.Target
	enabled   int
	owners    map[uint32]store.Owner
	instances []store.Instance
}

func (s *LeaseServer) snapshot(ctx context.Context) (*cluster, error) {
	targets, _, err := s.store.List(ctx)
	if err != nil {
		return nil, err
	}
	owners, err := s.store.Owners(ctx)
	if err != nil {
		return nil, err
	}
	instances, err := s.store.Instances(ctx)
	if err != nil {
		return nil, err
	}
	c := &cluster{targets: make(map[uint32]store.Target, len(targets)), owners: owners, instances: instances}
	for _, t := range targets {
		c.targets[t.ID] = t
		if t.Enabled {
			c.enabled++
		}
	}
	s.metrics.SetInstances(len(instances))
	return c, nil
}

func (c *cluster) ownedBy(instance string) []uint32 {
	var ids []uint32
	for id, o := range c.owners {
		if o.Instance == instance {
			if t, ok := c.targets[id]; ok && t.Enabled {
				ids = append(ids, id)
			}
		}
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	return ids
}

func (c *cluster) fairShare(instance string, capacity int32) int32 {
	live := len(c.instances)
	for _, in := range c.instances {
		if in.Name == instance {
			if capacity == 0 {
				capacity = in.Capacity
			}
		}
	}
	return lease.FairShare(c.enabled, live, capacity)
}

func (s *LeaseServer) checkSession(ctx context.Context, instance, session string) (int64, error) {
	if instance == "" {
		return 0, status.Error(codes.InvalidArgument, "instance is required")
	}
	leaseID, err := parseSession(session)
	if err != nil {
		return 0, err
	}
	if err := s.store.CheckSession(ctx, instance, leaseID); err != nil {
		return 0, storeErr(err)
	}
	return leaseID, nil
}

func (s *LeaseServer) RegisterInstance(ctx context.Context, req *registryv1.RegisterInstanceRequest) (*registryv1.RegisterInstanceResponse, error) {
	if req.GetInstance() == "" || req.GetCapacity() <= 0 {
		return nil, status.Error(codes.InvalidArgument, "instance and capacity are required")
	}
	inst, err := s.store.Register(ctx, store.Instance{Name: req.GetInstance(), Capacity: req.GetCapacity(), Version: req.GetVersion()}, s.ttl)
	s.metrics.LeaseCall("RegisterInstance", err)
	if err != nil {
		return nil, storeErr(err)
	}
	c, err := s.snapshot(ctx)
	if err != nil {
		return nil, storeErr(err)
	}
	s.log.Info("instance registered", "instance", inst.Name, "capacity", inst.Capacity, "lease", sessionID(inst.LeaseID))
	return &registryv1.RegisterInstanceResponse{
		SessionId:        sessionID(inst.LeaseID),
		LeaseTtlSec:      int32(s.ttl.Seconds()),
		RenewIntervalSec: int32(s.renew.Seconds()),
		FairShare:        c.fairShare(inst.Name, inst.Capacity),
	}, nil
}

func (s *LeaseServer) AcquireTargets(ctx context.Context, req *registryv1.AcquireTargetsRequest) (*registryv1.AcquireTargetsResponse, error) {
	leaseID, err := s.checkSession(ctx, req.GetInstance(), req.GetSessionId())
	if err != nil {
		return nil, err
	}
	c, err := s.snapshot(ctx)
	if err != nil {
		return nil, storeErr(err)
	}
	owned := c.ownedBy(req.GetInstance())
	fair := c.fairShare(req.GetInstance(), 0)
	want := int(req.GetWant())
	if room := int(fair) - len(owned); want > room {
		want = room
	}
	resp := &registryv1.AcquireTargetsResponse{FairShare: fair, OwnedTotal: int32(len(owned)), LeaseDeadlineUnix: time.Now().Add(s.ttl).Unix()}
	if want <= 0 {
		return resp, nil
	}
	free := make([]uint32, 0, want)
	ids := make([]uint32, 0, len(c.targets))
	for id := range c.targets {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	for _, id := range ids {
		if _, taken := c.owners[id]; taken || !c.targets[id].Enabled {
			continue
		}
		free = append(free, id)
		if len(free) >= want*2 { // a few extra candidates in case of races
			break
		}
	}
	var acquired []uint32
	for len(free) > 0 && len(acquired) < want {
		batch := free
		if len(batch) > want-len(acquired) {
			batch = batch[:want-len(acquired)]
		}
		free = free[len(batch):]
		taken, err := s.store.Acquire(ctx, req.GetInstance(), leaseID, batch)
		if err != nil {
			s.metrics.LeaseCall("AcquireTargets", err)
			return nil, storeErr(err)
		}
		acquired = append(acquired, taken...)
	}
	s.metrics.LeaseCall("AcquireTargets", nil)
	expires := time.Now().Add(s.ttl).Unix()
	for _, id := range acquired {
		resp.Acquired = append(resp.Acquired, &registryv1.Assignment{TargetId: id, Target: toProto(c.targets[id]), ExpiresAt: expires})
	}
	resp.OwnedTotal = int32(len(owned) + len(acquired))
	if len(acquired) > 0 {
		s.log.Info("targets acquired", "instance", req.GetInstance(), "n", len(acquired), "owned", resp.OwnedTotal, "fair_share", fair)
	}
	return resp, nil
}

func (s *LeaseServer) RenewLeases(ctx context.Context, req *registryv1.RenewLeasesRequest) (*registryv1.RenewLeasesResponse, error) {
	leaseID, err := s.checkSession(ctx, req.GetInstance(), req.GetSessionId())
	if err != nil {
		return nil, err
	}
	ttl, err := s.store.KeepAlive(ctx, leaseID)
	s.metrics.LeaseCall("RenewLeases", err)
	if err != nil {
		return nil, storeErr(err)
	}
	c, err := s.snapshot(ctx)
	if err != nil {
		return nil, storeErr(err)
	}
	owned := c.ownedBy(req.GetInstance())
	ownedSet := make(map[uint32]struct{}, len(owned))
	for _, id := range owned {
		ownedSet[id] = struct{}{}
	}
	resp := &registryv1.RenewLeasesResponse{
		FairShare:         c.fairShare(req.GetInstance(), 0),
		LeaseDeadlineUnix: time.Now().Unix() + ttl,
	}
	for _, id := range req.GetTargetIds() {
		switch {
		case hasID(ownedSet, id):
			resp.Renewed = append(resp.Renewed, id)
		case hasTarget(c, id):
			resp.Lost = append(resp.Lost, id)
		default:
			resp.NotOwnedSent = append(resp.NotOwnedSent, id)
		}
	}
	resp.ReleaseRequested = lease.ReleaseRequest(owned, resp.FairShare)
	return resp, nil
}

func hasID(set map[uint32]struct{}, id uint32) bool { _, ok := set[id]; return ok }
func hasTarget(c *cluster, id uint32) bool          { _, ok := c.targets[id]; return ok }

func (s *LeaseServer) ReleaseTargets(ctx context.Context, req *registryv1.ReleaseTargetsRequest) (*registryv1.ReleaseTargetsResponse, error) {
	if _, err := s.checkSession(ctx, req.GetInstance(), req.GetSessionId()); err != nil {
		return nil, err
	}
	ids := req.GetTargetIds()
	if req.GetAll() {
		owners, err := s.store.Owners(ctx)
		if err != nil {
			return nil, storeErr(err)
		}
		ids = ids[:0]
		for id, o := range owners {
			if o.Instance == req.GetInstance() {
				ids = append(ids, id)
			}
		}
	}
	n, err := s.store.Release(ctx, req.GetInstance(), ids)
	s.metrics.LeaseCall("ReleaseTargets", err)
	if err != nil {
		return nil, storeErr(err)
	}
	s.log.Info("targets released", "instance", req.GetInstance(), "n", n, "all", req.GetAll())
	return &registryv1.ReleaseTargetsResponse{Released: int32(n)}, nil
}

func (s *LeaseServer) ListAssignments(ctx context.Context, req *registryv1.ListAssignmentsRequest) (*registryv1.ListAssignmentsResponse, error) {
	c, err := s.snapshot(ctx)
	if err != nil {
		return nil, storeErr(err)
	}
	resp := &registryv1.ListAssignmentsResponse{}
	byInstance := map[string][]uint32{}
	for id, o := range c.owners {
		byInstance[o.Instance] = append(byInstance[o.Instance], id)
	}
	for _, in := range c.instances {
		if req.GetInstance() != "" && in.Name != req.GetInstance() {
			continue
		}
		ids := byInstance[in.Name]
		sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
		resp.Instances = append(resp.Instances, &registryv1.InstanceAssignments{
			Instance: in.Name, Capacity: in.Capacity, Version: in.Version,
			RegisteredAt: in.RegisteredAt, ExpiresAt: in.ExpiresAt, TargetIds: ids,
		})
	}
	unassigned := map[uint32]struct{}{}
	for id, t := range c.targets {
		if _, owned := c.owners[id]; !owned && t.Enabled {
			unassigned[id] = struct{}{}
		}
	}
	resp.Unassigned = sortedIDs(unassigned)
	return resp, nil
}
