// Package grpc exposes TargetService and ActivityService.
package grpc

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/health"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/reflection"
	"google.golang.org/grpc/status"

	dbperfv1 "github.com/yurasolovjov/dbperf/services/dbperf/gen/dbperf/v1"
	"github.com/yurasolovjov/dbperf/services/dbperf/internal/query"
	"github.com/yurasolovjov/dbperf/services/dbperf/internal/registry"
)

// Metrics is the telemetry the server reports.
type Metrics interface {
	ObserveAPI(method, code string, d time.Duration)
}

// Deps are the dependencies of the server.
type Deps struct {
	Query    *query.Service
	Targets  registry.TargetSource
	Status   *registry.StatusStore // nil when this process is not a collector
	Instance string
	Metrics  Metrics
	Log      *slog.Logger
	MaxConc  int
	MaxPoints int
}

// Server wraps a grpc.Server with both services registered.
type Server struct {
	srv *grpc.Server
	log *slog.Logger
}

// New builds the server with a concurrency limit and metrics interceptor.
func New(d Deps) *Server {
	sem := make(chan struct{}, d.MaxConc)
	limiter := func(ctx context.Context, req any, info *grpc.UnaryServerInfo, h grpc.UnaryHandler) (any, error) {
		started := time.Now()
		select {
		case sem <- struct{}{}:
		default:
			d.Metrics.ObserveAPI(info.FullMethod, codes.ResourceExhausted.String(), time.Since(started))
			return nil, status.Error(codes.ResourceExhausted, "too many concurrent queries")
		}
		defer func() { <-sem }()
		resp, err := h(ctx, req)
		d.Metrics.ObserveAPI(info.FullMethod, status.Code(err).String(), time.Since(started))
		return resp, err
	}
	s := grpc.NewServer(grpc.ChainUnaryInterceptor(limiter))
	dbperfv1.RegisterTargetServiceServer(s, &targetServer{deps: d})
	dbperfv1.RegisterActivityServiceServer(s, &activityServer{deps: d})
	hs := health.NewServer()
	hs.SetServingStatus("", healthpb.HealthCheckResponse_SERVING)
	healthpb.RegisterHealthServer(s, hs)
	reflection.Register(s)
	return &Server{srv: s, log: d.Log}
}

// Run serves until ctx is cancelled.
func (s *Server) Run(ctx context.Context, addr string) error {
	lis, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	s.log.Info("grpc listening", "addr", addr)
	errc := make(chan error, 1)
	go func() { errc <- s.srv.Serve(lis) }()
	select {
	case <-ctx.Done():
		stopped := make(chan struct{})
		go func() { s.srv.GracefulStop(); close(stopped) }()
		select {
		case <-stopped:
		case <-time.After(5 * time.Second):
			s.srv.Stop()
		}
		return ctx.Err()
	case err := <-errc:
		return err
	}
}

// toStatus maps service errors to gRPC codes.
func toStatus(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, query.ErrInvalid):
		return status.Error(codes.InvalidArgument, err.Error())
	case errors.Is(err, context.DeadlineExceeded):
		return status.Error(codes.DeadlineExceeded, err.Error())
	default:
		return status.Error(codes.Internal, err.Error())
	}
}
