package grpc

import (
	"context"
	"errors"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	dbperfv1 "github.com/yurasolovjov/dbperf/services/dbperf/gen/dbperf/v1"
	"github.com/yurasolovjov/dbperf/services/dbperf/internal/query"
)

type activityServer struct {
	dbperfv1.UnimplementedActivityServiceServer
	deps Deps
}

func (s *activityServer) GetActivityTimeSeries(ctx context.Context, req *dbperfv1.ActivityTimeSeriesRequest) (*dbperfv1.ActivityTimeSeriesResponse, error) {
	if req.GetSlicing() == nil {
		return nil, status.Error(codes.InvalidArgument, "slicing is required")
	}
	res, err := s.deps.Query.TimeSeries(ctx, query.TimeSeriesRequest{
		TargetID:    req.GetTargetId(),
		Range:       toRange(req.GetRange()),
		Step:        time.Duration(req.GetStepSeconds()) * time.Second,
		Slicing:     toTop(req.GetSlicing()),
		Filters:     toFilters(req.GetFilters()),
		ExcludeSelf: req.GetExcludeSelf(),
		MaxPoints:   int(req.GetMaxPoints()),
	})
	if err != nil {
		return nil, toStatus(err)
	}
	out := &dbperfv1.ActivityTimeSeriesResponse{
		Range:       &dbperfv1.TimeRange{StartUnix: res.Range.Start.Unix(), EndUnix: res.Range.End.Unix()},
		StepSeconds: int32(res.Step.Seconds()),
		Level:       res.Level,
		Timestamps:  unixes(res.Timestamps),
		Totals:      res.Totals,
	}
	for _, ser := range res.Series {
		out.Series = append(out.Series, &dbperfv1.Series{Slice: toSlice(ser.Slice), Values: ser.Values, Average: ser.Average})
	}
	return out, nil
}

func (s *activityServer) GetActivityTop(ctx context.Context, req *dbperfv1.ActivityTopRequest) (*dbperfv1.ActivityTopResponse, error) {
	if req.GetSlicing() == nil {
		return nil, status.Error(codes.InvalidArgument, "slicing is required")
	}
	q := query.TopRequest{
		TargetID:    req.GetTargetId(),
		Range:       toRange(req.GetRange()),
		Slicing:     toTop(req.GetSlicing()),
		Filters:     toFilters(req.GetFilters()),
		ExcludeSelf: req.GetExcludeSelf(),
	}
	if req.GetSubSlicing() != nil {
		sub := toTop(req.GetSubSlicing())
		q.SubSlicing = &sub
	}
	res, err := s.deps.Query.Top(ctx, q)
	if err != nil {
		return nil, toStatus(err)
	}
	out := &dbperfv1.ActivityTopResponse{TotalAas: res.TotalAAS, NSamples: res.NSamples}
	for _, e := range res.Entries {
		out.Entries = append(out.Entries, toEntry(e))
	}
	return out, nil
}

func (s *activityServer) GetActivityTotals(ctx context.Context, req *dbperfv1.ActivityTotalsRequest) (*dbperfv1.ActivityTotalsResponse, error) {
	res, err := s.deps.Query.Totals(ctx, query.TotalsRequest{
		TargetID:    req.GetTargetId(),
		Range:       toRange(req.GetRange()),
		Step:        time.Duration(req.GetStepSeconds()) * time.Second,
		Filters:     toFilters(req.GetFilters()),
		ExcludeSelf: req.GetExcludeSelf(),
	})
	if err != nil {
		return nil, toStatus(err)
	}
	return &dbperfv1.ActivityTotalsResponse{
		StepSeconds: int32(res.Step.Seconds()),
		Timestamps:  unixes(res.Timestamps),
		Values:      res.Values,
		Average:     res.Average,
	}, nil
}

func (s *activityServer) ListSessions(ctx context.Context, req *dbperfv1.ListSessionsRequest) (*dbperfv1.ListSessionsResponse, error) {
	if req.GetAtUnix() <= 0 {
		return nil, status.Error(codes.InvalidArgument, "at_unix is required")
	}
	res, err := s.deps.Query.Sessions(ctx, query.SessionsRequest{
		TargetID: req.GetTargetId(),
		At:       time.Unix(req.GetAtUnix(), 0).UTC(),
		Filters:  toFilters(req.GetFilters()),
		Limit:    int(req.GetLimit()),
	})
	if err != nil {
		return nil, toStatus(err)
	}
	out := &dbperfv1.ListSessionsResponse{}
	if !res.SampleTS.IsZero() {
		out.SampleTs = res.SampleTS.Unix()
	}
	for _, r := range res.Sessions {
		out.Sessions = append(out.Sessions, &dbperfv1.Session{
			Ts: r.TS.Unix(), Pid: r.PID, LeaderPid: r.LeaderPID,
			BackendType: r.BackendType, Datname: r.Datname, Usename: r.Usename, ApplicationName: r.ApplicationName,
			ClientAddr: r.ClientAddr, State: r.State, WaitEventType: r.WaitEventType, WaitEvent: r.WaitEvent,
			BackendStart: unixOrZero(r.BackendStart), XactStart: unixOrZero(r.XactStart),
			QueryStart: unixOrZero(r.QueryStart), StateChange: unixOrZero(r.StateChange),
			QueryHash: r.QueryHash, QueryShort: r.QueryShort,
		})
	}
	return out, nil
}

func (s *activityServer) GetQueryText(ctx context.Context, req *dbperfv1.GetQueryTextRequest) (*dbperfv1.GetQueryTextResponse, error) {
	text, seen, truncated, err := s.deps.Query.QueryText(ctx, req.GetTargetId(), req.GetQueryHash())
	if err != nil {
		if errors.Is(err, errNoRows) || isNoRows(err) {
			return nil, status.Error(codes.NotFound, "query text not found")
		}
		return nil, toStatus(err)
	}
	return &dbperfv1.GetQueryTextResponse{Query: text, LastSeen: seen.Unix(), Truncated: truncated}, nil
}

var errNoRows = errors.New("no rows")

func isNoRows(err error) bool {
	return err != nil && (err.Error() == "sql: no rows in result set" || err.Error() == "no rows in result set")
}

func toRange(r *dbperfv1.TimeRange) query.Range {
	if r == nil {
		return query.Range{}
	}
	return query.Range{Start: time.Unix(r.GetStartUnix(), 0).UTC(), End: time.Unix(r.GetEndUnix(), 0).UTC()}
}

func toTop(t *dbperfv1.TopSlicing) query.TopSlicing {
	return query.TopSlicing{Dim: query.Dimension(t.GetDimension()), Limit: int(t.GetLimit())}
}

func toFilters(fs []*dbperfv1.Filter) []query.Filter {
	out := make([]query.Filter, 0, len(fs))
	for _, f := range fs {
		out = append(out, query.Filter{Dim: query.Dimension(f.GetDimension()), Values: f.GetValues(), Exclude: f.GetExclude()})
	}
	return out
}

func toSlice(v query.SliceValue) *dbperfv1.SliceValue {
	return &dbperfv1.SliceValue{Value: v.Value, ShortText: v.ShortText, IsRemainder: v.IsRemainder, Id: v.ID}
}

func toEntry(e query.TopEntry) *dbperfv1.TopEntry {
	out := &dbperfv1.TopEntry{Slice: toSlice(e.Slice), Aas: e.AAS, Percent: e.Percent}
	for _, s := range e.Sub {
		out.Sub = append(out.Sub, toEntry(s))
	}
	return out
}

func unixes(ts []time.Time) []int64 {
	out := make([]int64, len(ts))
	for i, t := range ts {
		out[i] = t.Unix()
	}
	return out
}

func unixOrZero(t time.Time) int64 {
	if t.IsZero() || t.Unix() <= 0 {
		return 0
	}
	return t.Unix()
}
