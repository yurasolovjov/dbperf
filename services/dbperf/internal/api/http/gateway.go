// Package http is a JSON gateway over the gRPC services for browsers: every
// method is POST /api/v1/<service>/<method> with the protobuf JSON mapping
// (protojson) for both request and response, so the schema is the proto.
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

	dbperfv1 "github.com/yurasolovjov/dbperf/services/dbperf/gen/dbperf/v1"
)

// Gateway serves the JSON API.
type Gateway struct {
	targets  dbperfv1.TargetServiceServer
	activity dbperfv1.ActivityServiceServer
	sem      chan struct{}
	log      *slog.Logger
}

// New creates a gateway over the service implementations.
func New(t dbperfv1.TargetServiceServer, a dbperfv1.ActivityServiceServer, maxConc int, log *slog.Logger) *Gateway {
	if maxConc <= 0 {
		maxConc = 32
	}
	return &Gateway{targets: t, activity: a, sem: make(chan struct{}, maxConc), log: log}
}

const maxBody = 1 << 20

var (
	unmarshal = protojson.UnmarshalOptions{DiscardUnknown: true}
	marshal   = protojson.MarshalOptions{EmitUnpopulated: true}
)

// Mount registers the routes on a mux.
func (g *Gateway) Mount(mux *http.ServeMux) {
	mux.Handle("POST /api/v1/targets/list", handle(g, g.targets.ListTargets))
	mux.Handle("POST /api/v1/targets/status", handle(g, g.targets.GetTargetStatus))
	mux.Handle("POST /api/v1/activity/timeseries", handle(g, g.activity.GetActivityTimeSeries))
	mux.Handle("POST /api/v1/activity/top", handle(g, g.activity.GetActivityTop))
	mux.Handle("POST /api/v1/activity/totals", handle(g, g.activity.GetActivityTotals))
	mux.Handle("POST /api/v1/activity/sessions", handle(g, g.activity.ListSessions))
	mux.Handle("POST /api/v1/activity/query-text", handle(g, g.activity.GetQueryText))
	// GET convenience for the target list
	mux.HandleFunc("GET /api/v1/targets", func(w http.ResponseWriter, r *http.Request) {
		resp, err := g.targets.ListTargets(r.Context(), &dbperfv1.ListTargetsRequest{NameFilter: r.URL.Query().Get("name")})
		g.write(w, resp, err)
	})
}

// handle adapts a unary gRPC method to an HTTP handler.
func handle[Req, Resp proto.Message](g *Gateway, fn func(context.Context, Req) (Resp, error)) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case g.sem <- struct{}{}:
			defer func() { <-g.sem }()
		default:
			writeError(w, http.StatusTooManyRequests, "too many concurrent queries")
			return
		}
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
		ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
		defer cancel()
		resp, err := fn(ctx, req)
		g.write(w, resp, err)
	})
}

func (g *Gateway) write(w http.ResponseWriter, resp proto.Message, err error) {
	if err != nil {
		code, msg := http.StatusInternalServerError, err.Error()
		if st, ok := status.FromError(err); ok {
			code, msg = httpCode(st.Code()), st.Message()
		} else if errors.Is(err, context.DeadlineExceeded) {
			code = http.StatusGatewayTimeout
		}
		if code >= 500 {
			g.log.Warn("api error", "err", err)
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
}

func httpCode(c codes.Code) int {
	switch c {
	case codes.OK:
		return http.StatusOK
	case codes.InvalidArgument:
		return http.StatusBadRequest
	case codes.NotFound:
		return http.StatusNotFound
	case codes.ResourceExhausted:
		return http.StatusTooManyRequests
	case codes.DeadlineExceeded:
		return http.StatusGatewayTimeout
	case codes.Unimplemented:
		return http.StatusNotImplemented
	}
	return http.StatusInternalServerError
}

func writeError(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
