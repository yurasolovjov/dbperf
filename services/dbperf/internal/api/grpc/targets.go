package grpc

import (
	"context"
	"strconv"
	"strings"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	dbperfv1 "github.com/yurasolovjov/dbperf/services/dbperf/gen/dbperf/v1"
	"github.com/yurasolovjov/dbperf/services/dbperf/internal/registry"
)

type targetServer struct {
	dbperfv1.UnimplementedTargetServiceServer
	deps Deps
}

func (s *targetServer) ListTargets(ctx context.Context, req *dbperfv1.ListTargetsRequest) (*dbperfv1.ListTargetsResponse, error) {
	all, err := s.deps.Targets.List(ctx)
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
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
	resp := &dbperfv1.ListTargetsResponse{}
	for _, t := range all {
		if t.ID <= after {
			continue
		}
		if filter != "" && !strings.Contains(strings.ToLower(t.Name), filter) {
			continue
		}
		if len(resp.Targets) == size {
			resp.NextPageToken = strconv.FormatUint(uint64(resp.Targets[size-1].TargetId), 10)
			break
		}
		resp.Targets = append(resp.Targets, &dbperfv1.Target{
			TargetId:    t.ID,
			Name:        t.Name,
			IntervalSec: int32(t.Interval.Seconds()),
			Enabled:     t.Enabled,
		})
	}
	return resp, nil
}

func (s *targetServer) GetTargetStatus(ctx context.Context, req *dbperfv1.GetTargetStatusRequest) (*dbperfv1.TargetStatus, error) {
	all, err := s.deps.Targets.List(ctx)
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	var found *registry.Target
	for i := range all {
		if all[i].ID == req.GetTargetId() {
			found = &all[i]
			break
		}
	}
	if found == nil {
		return nil, status.Errorf(codes.NotFound, "target %d not found", req.GetTargetId())
	}
	out := &dbperfv1.TargetStatus{TargetId: found.ID}
	if !found.Enabled {
		out.State = dbperfv1.TargetStatus_DISABLED
		return out, nil
	}
	if s.deps.Status != nil {
		if st, ok := s.deps.Status.Get(found.ID); ok {
			out.OwnerInstance = s.deps.Instance
			out.State = mapState(st.State)
			if !st.DisconnectedSince.IsZero() {
				out.DisconnectedSince = st.DisconnectedSince.Unix()
			}
			if !st.LastSampleAt.IsZero() {
				out.LastSampleAt = st.LastSampleAt.Unix()
			}
			out.LastError = st.LastError
			out.ServerVersionNum = st.ServerVersionNum
			out.LastSampleDurationMs = st.LastSampleDurationMs
			return out, nil
		}
	}
	// Not owned by this process: ask the registry who runs it.
	out.State = dbperfv1.TargetStatus_STATE_UNSPECIFIED
	if ol, ok := s.deps.Targets.(registry.OwnerLookup); ok {
		if owner, err := ol.Owner(ctx, found.ID); err == nil {
			out.OwnerInstance = owner
		}
	}
	return out, nil
}

func mapState(s registry.State) dbperfv1.TargetStatus_State {
	switch s {
	case registry.StateConnected:
		return dbperfv1.TargetStatus_CONNECTED
	case registry.StateDisconnected:
		return dbperfv1.TargetStatus_DISCONNECTED
	case registry.StateDisabled:
		return dbperfv1.TargetStatus_DISABLED
	}
	return dbperfv1.TargetStatus_STATE_UNSPECIFIED
}
