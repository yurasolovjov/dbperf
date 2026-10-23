package grpc

import (
	"context"
	"log/slog"
	"sort"
	"strconv"
	"strings"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/emptypb"

	registryv1 "github.com/yurasolovjov/dbperf/services/registry/gen/dbperf/registry/v1"
	"github.com/yurasolovjov/dbperf/services/registry/internal/store"
)

// TargetServer implements TargetRegistry.
type TargetServer struct {
	registryv1.UnimplementedTargetRegistryServer
	store   *store.Store
	log     *slog.Logger
	metrics Metrics
}

// NewTargetServer creates the service.
func NewTargetServer(st *store.Store, m Metrics, log *slog.Logger) *TargetServer {
	return &TargetServer{store: st, metrics: m, log: log}
}

func (s *TargetServer) CreateTarget(ctx context.Context, req *registryv1.CreateTargetRequest) (*registryv1.Target, error) {
	t := store.Target{
		ID: req.GetTargetId(), Name: req.GetName(), DSN: req.GetDsn(), IntervalSec: req.GetIntervalSec(),
		StatementTimeoutMs: req.GetStatementTimeoutMs(), Enabled: true, Labels: req.GetLabels(),
	}
	if req.Enabled != nil {
		t.Enabled = req.GetEnabled()
	}
	if err := validate(&t); err != nil {
		return nil, err
	}
	created, err := s.store.Create(ctx, t)
	if err != nil {
		return nil, storeErr(err)
	}
	s.log.Info("target created", "id", created.ID, "name", created.Name)
	s.metrics.TargetsChanged()
	return toProto(created), nil
}

func (s *TargetServer) GetTarget(ctx context.Context, req *registryv1.GetTargetRequest) (*registryv1.Target, error) {
	var t store.Target
	var err error
	switch {
	case req.GetTargetId() != 0:
		t, err = s.store.Get(ctx, req.GetTargetId())
	case req.GetName() != "":
		t, err = s.store.GetByName(ctx, req.GetName())
	default:
		return nil, status.Error(codes.InvalidArgument, "target_id or name is required")
	}
	if err != nil {
		return nil, storeErr(err)
	}
	return toProto(t), nil
}

func (s *TargetServer) ListTargets(ctx context.Context, req *registryv1.ListTargetsRequest) (*registryv1.ListTargetsResponse, error) {
	all, rev, err := s.store.List(ctx)
	if err != nil {
		return nil, storeErr(err)
	}
	size := int(req.GetPageSize())
	if size <= 0 || size > 1000 {
		size = 1000
	}
	var after uint32
	if tok := req.GetPageToken(); tok != "" {
		v, err := strconv.ParseUint(tok, 10, 32)
		if err != nil {
			return nil, status.Error(codes.InvalidArgument, "bad page_token")
		}
		after = uint32(v)
	}
	filter := strings.ToLower(req.GetNameFilter())
	resp := &registryv1.ListTargetsResponse{Revision: rev}
	for _, t := range all {
		if t.ID <= after {
			continue
		}
		if filter != "" && !strings.Contains(strings.ToLower(t.Name), filter) {
			continue
		}
		if req.Enabled != nil && t.Enabled != req.GetEnabled() {
			continue
		}
		if !labelsMatch(t.Labels, req.GetLabelSelector()) {
			continue
		}
		if len(resp.Targets) == size {
			resp.NextPageToken = strconv.FormatUint(uint64(resp.Targets[size-1].TargetId), 10)
			break
		}
		resp.Targets = append(resp.Targets, toProto(t))
	}
	return resp, nil
}

func labelsMatch(have, want map[string]string) bool {
	for k, v := range want {
		if have[k] != v {
			return false
		}
	}
	return true
}

func (s *TargetServer) UpdateTarget(ctx context.Context, req *registryv1.UpdateTargetRequest) (*registryv1.Target, error) {
	in := req.GetTarget()
	if in.GetTargetId() == 0 {
		return nil, status.Error(codes.InvalidArgument, "target.target_id is required")
	}
	cur, err := s.store.Get(ctx, in.GetTargetId())
	if err != nil {
		return nil, storeErr(err)
	}
	paths := req.GetUpdateMask().GetPaths()
	if len(paths) == 0 {
		paths = []string{"name", "dsn", "interval_sec", "statement_timeout_ms", "enabled", "labels"}
	}
	for _, p := range paths {
		switch p {
		case "name":
			cur.Name = in.GetName()
		case "dsn":
			cur.DSN = in.GetDsn()
		case "interval_sec":
			cur.IntervalSec = in.GetIntervalSec()
		case "statement_timeout_ms":
			cur.StatementTimeoutMs = in.GetStatementTimeoutMs()
		case "enabled":
			cur.Enabled = in.GetEnabled()
		case "labels":
			cur.Labels = in.GetLabels()
		default:
			return nil, status.Errorf(codes.InvalidArgument, "update_mask: unknown path %q", p)
		}
	}
	if err := validate(&cur); err != nil {
		return nil, err
	}
	updated, err := s.store.Update(ctx, cur, req.GetExpectedRevision())
	if err != nil {
		return nil, storeErr(err)
	}
	s.log.Info("target updated", "id", updated.ID, "paths", paths)
	s.metrics.TargetsChanged()
	return toProto(updated), nil
}

func (s *TargetServer) DeleteTarget(ctx context.Context, req *registryv1.DeleteTargetRequest) (*emptypb.Empty, error) {
	if err := s.store.Delete(ctx, req.GetTargetId()); err != nil {
		return nil, storeErr(err)
	}
	s.log.Info("target deleted", "id", req.GetTargetId())
	s.metrics.TargetsChanged()
	return &emptypb.Empty{}, nil
}

func (s *TargetServer) WatchTargets(req *registryv1.WatchTargetsRequest, stream registryv1.TargetRegistry_WatchTargetsServer) error {
	ctx := stream.Context()
	for ev := range s.store.Watch(ctx, req.GetSinceRevision()) {
		out := &registryv1.TargetEvent{TargetId: ev.ID, Revision: ev.Revision, Type: registryv1.TargetEvent_PUT}
		if ev.Deleted {
			out.Type = registryv1.TargetEvent_DELETE
		} else {
			out.Target = toProto(ev.Target)
		}
		if err := stream.Send(out); err != nil {
			return err
		}
	}
	return ctx.Err()
}

// sortedIDs returns the ids of a map in ascending order.
func sortedIDs(m map[uint32]struct{}) []uint32 {
	out := make([]uint32, 0, len(m))
	for id := range m {
		out = append(out, id)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

// BulkCreateTargets creates each entry independently and reports all of them.
func (s *TargetServer) BulkCreateTargets(ctx context.Context, req *registryv1.BulkCreateTargetsRequest) (*registryv1.BulkCreateTargetsResponse, error) {
	if n := len(req.GetTargets()); n == 0 || n > 5000 {
		return nil, status.Error(codes.InvalidArgument, "targets: 1..5000 entries")
	}
	resp := &registryv1.BulkCreateTargetsResponse{}
	for i, in := range req.GetTargets() {
		r := &registryv1.BulkCreateResult{Index: int32(i), Name: in.GetName()}
		created, err := s.CreateTarget(ctx, in)
		switch {
		case err == nil:
			r.Status, r.TargetId = registryv1.BulkCreateResult_CREATED, created.GetTargetId()
			resp.Created++
		case status.Code(err) == codes.AlreadyExists && req.GetSkipExisting():
			r.Status = registryv1.BulkCreateResult_SKIPPED
			if ex, gerr := s.store.GetByName(ctx, in.GetName()); gerr == nil {
				r.TargetId = ex.ID
			}
			resp.Skipped++
		default:
			r.Status, r.Error = registryv1.BulkCreateResult_FAILED, status.Convert(err).Message()
			resp.Failed++
		}
		resp.Results = append(resp.Results, r)
	}
	s.log.Info("bulk create", "created", resp.Created, "skipped", resp.Skipped, "failed", resp.Failed)
	return resp, nil
}
