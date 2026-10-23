// Package http is a JSON gateway over the registry gRPC services for the
// browser: POST /api/v1/registry/<resource>/<action> with the protojson
// mapping of the proto messages.
package http

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	registryv1 "github.com/yurasolovjov/dbperf/services/registry/gen/dbperf/registry/v1"
)

// Gateway serves the JSON API.
type Gateway struct {
	targets registryv1.TargetRegistryServer
	leases  registryv1.LeaseServiceServer
	log     *slog.Logger
}

// New creates a gateway over the service implementations.
func New(t registryv1.TargetRegistryServer, l registryv1.LeaseServiceServer, log *slog.Logger) *Gateway {
	return &Gateway{targets: t, leases: l, log: log}
}

const maxBody = 8 << 20 // bulk imports carry thousands of DSNs

var (
	unmarshal = protojson.UnmarshalOptions{DiscardUnknown: true}
	marshal   = protojson.MarshalOptions{EmitUnpopulated: true}
)

// Mount registers the routes.
func (g *Gateway) Mount(mux *http.ServeMux) {
	mux.Handle("POST /api/v1/registry/targets/list", handle(g, g.targets.ListTargets))
	mux.Handle("POST /api/v1/registry/targets/get", handle(g, g.targets.GetTarget))
	mux.Handle("POST /api/v1/registry/targets/create", handle(g, g.targets.CreateTarget))
	mux.Handle("POST /api/v1/registry/targets/update", handle(g, g.targets.UpdateTarget))
	mux.Handle("POST /api/v1/registry/targets/delete", handle(g, g.targets.DeleteTarget))
	mux.Handle("POST /api/v1/registry/targets/bulk-create", handle(g, g.targets.BulkCreateTargets))
	mux.Handle("POST /api/v1/registry/assignments", handle(g, g.leases.ListAssignments))
}

func handle[Req, Resp proto.Message](g *Gateway, fn func(context.Context, Req) (Resp, error)) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(io.LimitReader(r.Body, maxBody))
		if err != nil {
			writeError(w, http.StatusBadRequest, "read body: "+err.Error())
			return
		}
		var zero Req
		req := zero.ProtoReflect().New().Interface().(Req)
		if len(body) > 0 {
			if err := unmarshal.Unmarshal(body, req); err != nil {
				writeError(w, http.StatusBadRequest, "decode request: "+err.Error())
				return
			}
		}
		ctx, cancel := context.WithTimeout(r.Context(), 120*time.Second)
		defer cancel()
		resp, err := fn(ctx, req)
		if err != nil {
			code, msg := http.StatusInternalServerError, err.Error()
			if st, ok := status.FromError(err); ok {
				code, msg = httpCode(st.Code()), st.Message()
			} else if errors.Is(err, context.DeadlineExceeded) {
				code = http.StatusGatewayTimeout
			}
			if code >= 500 {
				g.log.Warn("api error", "path", r.URL.Path, "err", err)
			}
			writeError(w, code, msg)
			return
		}
		data, err := marshal.Marshal(resp)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "encode response: "+err.Error())
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(data)
	})
}

func httpCode(c codes.Code) int {
	switch c {
	case codes.OK:
		return http.StatusOK
	case codes.InvalidArgument:
		return http.StatusBadRequest
	case codes.NotFound:
		return http.StatusNotFound
	case codes.AlreadyExists:
		return http.StatusConflict
	case codes.FailedPrecondition:
		return http.StatusPreconditionFailed
	case codes.Aborted:
		return http.StatusConflict
	case codes.PermissionDenied:
		return http.StatusForbidden
	case codes.ResourceExhausted:
		return http.StatusTooManyRequests
	case codes.Unavailable:
		return http.StatusServiceUnavailable
	case codes.DeadlineExceeded:
		return http.StatusGatewayTimeout
	}
	return http.StatusInternalServerError
}

func writeError(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
