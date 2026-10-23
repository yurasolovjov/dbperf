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

	registryv1 "github.com/yurasolovjov/dbperf/services/registry/gen/dbperf/registry/v1"
)

type fakeTargets struct {
	registryv1.UnimplementedTargetRegistryServer
	got *registryv1.BulkCreateTargetsRequest
}

func (f *fakeTargets) BulkCreateTargets(_ context.Context, r *registryv1.BulkCreateTargetsRequest) (*registryv1.BulkCreateTargetsResponse, error) {
	f.got = r
	return &registryv1.BulkCreateTargetsResponse{Created: int32(len(r.GetTargets()))}, nil
}

func (f *fakeTargets) CreateTarget(context.Context, *registryv1.CreateTargetRequest) (*registryv1.Target, error) {
	return nil, status.Error(codes.AlreadyExists, "name already exists")
}

type fakeLeases struct {
	registryv1.UnimplementedLeaseServiceServer
}

func TestBulkDecodeAndConflict(t *testing.T) {
	ft := &fakeTargets{}
	mux := http.NewServeMux()
	New(ft, &fakeLeases{}, slog.Default()).Mount(mux)

	rr := httptest.NewRecorder()
	body := `{"targets":[{"name":"a","dsn":"postgres://u@h/a","intervalSec":5,"labels":{"env":"dev"}},{"name":"b","dsn":"postgres://u@h/b","enabled":false}],"skipExisting":true}`
	mux.ServeHTTP(rr, httptest.NewRequest("POST", "/api/v1/registry/targets/bulk-create", strings.NewReader(body)))
	if rr.Code != 200 || ft.got == nil || len(ft.got.GetTargets()) != 2 || !ft.got.GetSkipExisting() {
		t.Fatalf("code %d body %s", rr.Code, rr.Body.String())
	}
	if ft.got.GetTargets()[1].Enabled == nil || ft.got.GetTargets()[1].GetEnabled() {
		t.Fatal("optional enabled=false must survive decoding")
	}
	if !strings.Contains(strings.ReplaceAll(rr.Body.String(), " ", ""), `"created":2`) {
		t.Fatalf("body %s", rr.Body.String())
	}

	rr = httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest("POST", "/api/v1/registry/targets/create", strings.NewReader(`{"name":"a","dsn":"postgres://u@h/a"}`)))
	if rr.Code != http.StatusConflict {
		t.Fatalf("ALREADY_EXISTS must map to 409, got %d", rr.Code)
	}
}
