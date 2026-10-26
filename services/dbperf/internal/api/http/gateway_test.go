package http

import (
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	dbperfv1 "github.com/yurasolovjov/dbperf/services/dbperf/gen/dbperf/v1"
)

type fakeTargets struct {
	dbperfv1.UnimplementedTargetServiceServer
	gotFilter string
}

func (f *fakeTargets) ListTargets(_ context.Context, r *dbperfv1.ListTargetsRequest) (*dbperfv1.ListTargetsResponse, error) {
	f.gotFilter = r.GetNameFilter()
	return &dbperfv1.ListTargetsResponse{Targets: []*dbperfv1.Target{{TargetId: 7, Name: "pg", IntervalSec: 10, Enabled: true}}}, nil
}

func (f *fakeTargets) GetTargetStatus(context.Context, *dbperfv1.GetTargetStatusRequest) (*dbperfv1.TargetStatus, error) {
	return nil, status.Error(codes.NotFound, "no such target")
}

type fakeActivity struct {
	dbperfv1.UnimplementedActivityServiceServer
	got *dbperfv1.ActivityTimeSeriesRequest
}

func (f *fakeActivity) GetActivityTimeSeries(_ context.Context, r *dbperfv1.ActivityTimeSeriesRequest) (*dbperfv1.ActivityTimeSeriesResponse, error) {
	f.got = r
	return &dbperfv1.ActivityTimeSeriesResponse{StepSeconds: 10, Level: "raw", Timestamps: []int64{1, 2}, Totals: []float64{0.5, 1}}, nil
}

func newMux(t *dbperfv1.TargetServiceServer, a *dbperfv1.ActivityServiceServer) *http.ServeMux {
	mux := http.NewServeMux()
	New(*t, *a, 4, slog.Default()).Mount(mux)
	return mux
}

func TestListTargetsJSON(t *testing.T) {
	ft := &fakeTargets{}
	var ts dbperfv1.TargetServiceServer = ft
	var as dbperfv1.ActivityServiceServer = &fakeActivity{}
	mux := newMux(&ts, &as)
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest("POST", "/api/v1/targets/list", strings.NewReader(`{"nameFilter":"p"}`)))
	if rr.Code != 200 || ft.gotFilter != "p" {
		t.Fatalf("code %d filter %q body %s", rr.Code, ft.gotFilter, rr.Body.String())
	}
	compact := strings.NewReplacer(" ", "", "\n", "").Replace(rr.Body.String())
	if !strings.Contains(compact, `"targetId":7`) || !strings.Contains(compact, `"nextPageToken":""`) {
		t.Fatalf("body %s", rr.Body.String())
	}
}

func TestTimeSeriesDecodesEnumsAndInt64(t *testing.T) {
	fa := &fakeActivity{}
	var ts dbperfv1.TargetServiceServer = &fakeTargets{}
	var as dbperfv1.ActivityServiceServer = fa
	mux := newMux(&ts, &as)
	rr := httptest.NewRecorder()
	body := `{"targetId":2,"range":{"startUnix":"1700000000","endUnix":1700003600},"stepSeconds":10,
	          "slicing":{"dimension":"WAIT_EVENT_TYPE","limit":5},"filters":[{"dimension":"DATNAME","values":["shop"]}],"excludeSelf":true}`
	mux.ServeHTTP(rr, httptest.NewRequest("POST", "/api/v1/activity/timeseries", strings.NewReader(body)))
	if rr.Code != 200 {
		t.Fatalf("code %d body %s", rr.Code, rr.Body.String())
	}
	if fa.got.GetRange().GetStartUnix() != 1700000000 || fa.got.GetRange().GetEndUnix() != 1700003600 ||
		fa.got.GetSlicing().GetDimension() != dbperfv1.Dimension_WAIT_EVENT_TYPE || len(fa.got.GetFilters()) != 1 || !fa.got.GetExcludeSelf() {
		t.Fatalf("decoded %+v", fa.got)
	}
	// protojson randomizes whitespace on purpose; compare without it.
	compact := strings.NewReplacer(" ", "", "\n", "").Replace(rr.Body.String())
	if !strings.Contains(compact, `"timestamps":["1","2"]`) {
		t.Fatalf("body %s", rr.Body.String())
	}
}

func TestErrorsMapToHTTP(t *testing.T) {
	var ts dbperfv1.TargetServiceServer = &fakeTargets{}
	var as dbperfv1.ActivityServiceServer = &fakeActivity{}
	mux := newMux(&ts, &as)
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest("POST", "/api/v1/targets/status", strings.NewReader(`{"targetId":1}`)))
	if rr.Code != 404 || !strings.Contains(rr.Body.String(), "no such target") {
		t.Fatalf("code %d body %s", rr.Code, rr.Body.String())
	}
	rr = httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest("POST", "/api/v1/targets/list", strings.NewReader(`{bad json`)))
	if rr.Code != 400 {
		t.Fatalf("code %d", rr.Code)
	}
}

type fakeTop struct {
	dbperfv1.UnimplementedActivityServiceServer
	got *dbperfv1.ActivityTopRequest
}

func (f *fakeTop) GetActivityTop(_ context.Context, r *dbperfv1.ActivityTopRequest) (*dbperfv1.ActivityTopResponse, error) {
	f.got = r
	return &dbperfv1.ActivityTopResponse{MatchedRows: 42, TotalAas: 1, NSamples: 10, Level: "raw"}, nil
}
func TestTableFilterWireContract(t *testing.T) {
	f := &fakeTop{}
	var ts dbperfv1.TargetServiceServer = &fakeTargets{}
	var as dbperfv1.ActivityServiceServer = f
	mux := newMux(&ts, &as)
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest("POST", "/api/v1/activity/top", strings.NewReader(`{"targetId":1,"range":{"startUnix":1700000000,"endUnix":1700000300},"slicing":{"dimension":"DATNAME","limit":8},"tableFilters":[{"dimension":"QUERY","match":"MATCH_CONTAINS","values":["orders"],"exclude":true}],"aas":{"min":0},"percent":{"max":50},"pageSize":8,"offset":8}`)))
	if rr.Code != 200 {
		t.Fatalf("%d %s", rr.Code, rr.Body)
	}
	if f.got.GetAas().Min == nil || *f.got.GetAas().Min != 0 || f.got.GetAas().Max != nil || f.got.GetPercent().GetMax() != 50 || f.got.GetOffset() != 8 || f.got.GetPageSize() != 8 {
		t.Fatalf("optional/pagination contract: %+v", f.got)
	}
	filter := f.got.GetTableFilters()[0]
	if filter.GetMatch() != dbperfv1.FilterMatch_MATCH_CONTAINS || !filter.GetExclude() || filter.GetDimension() != dbperfv1.Dimension_QUERY {
		t.Fatalf("filter: %+v", filter)
	}
	compact := strings.NewReplacer(" ", "", "\n", "").Replace(rr.Body.String())
	if !strings.Contains(compact, `"matchedRows":"42"`) {
		t.Fatal(compact)
	}
}
