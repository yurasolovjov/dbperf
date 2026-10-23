// Command registry serves TargetRegistry and LeaseService over etcd.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/health"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/reflection"

	registryv1 "github.com/yurasolovjov/dbperf/services/registry/gen/dbperf/registry/v1"
	api "github.com/yurasolovjov/dbperf/services/registry/internal/api/grpc"
	"github.com/yurasolovjov/dbperf/services/registry/internal/store"
)

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	var (
		endpoints = flag.String("etcd", envOr("ETCD_ENDPOINTS", "localhost:2379"), "etcd endpoints, comma separated")
		prefix    = flag.String("prefix", envOr("ETCD_PREFIX", "/dbperf/"), "etcd key prefix")
		grpcAddr  = flag.String("grpc", envOr("GRPC_ADDR", ":9100"), "gRPC listen address")
		httpAddr  = flag.String("http", envOr("HTTP_ADDR", ":9101"), "HTTP listen address (/metrics, /healthz)")
		ttl       = flag.Duration("lease-ttl", 30*time.Second, "instance lease TTL")
		renew     = flag.Duration("renew-interval", 10*time.Second, "recommended renew period")
	)
	flag.Parse()
	log := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	st, err := store.New(ctx, strings.Split(*endpoints, ","), *prefix, 5*time.Second)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer st.Close()
	metrics := api.NewPromMetrics()

	srv := grpc.NewServer()
	registryv1.RegisterTargetRegistryServer(srv, api.NewTargetServer(st, metrics, log.With("component", "targets")))
	registryv1.RegisterLeaseServiceServer(srv, api.NewLeaseServer(st, *ttl, *renew, metrics, log.With("component", "lease")))
	hs := health.NewServer()
	hs.SetServingStatus("", healthpb.HealthCheckResponse_SERVING)
	healthpb.RegisterHealthServer(srv, hs)
	reflection.Register(srv)

	lis, err := net.Listen("tcp", *grpcAddr)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	mux := http.NewServeMux()
	mux.Handle("/metrics", metrics.Handler())
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok\n")) })
	hsrv := &http.Server{Addr: *httpAddr, Handler: mux, ReadHeaderTimeout: 5 * time.Second}

	errc := make(chan error, 2)
	go func() { errc <- srv.Serve(lis) }()
	go func() {
		if err := hsrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errc <- err
		}
	}()
	log.Info("registry started", "grpc", *grpcAddr, "http", *httpAddr, "etcd", *endpoints, "lease_ttl", ttl.String())
	select {
	case <-ctx.Done():
	case err := <-errc:
		log.Error("server failed", "err", err)
	}
	sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = hsrv.Shutdown(sctx)
	srv.GracefulStop()
	log.Info("registry stopped")
}
