// Command dbperf runs the collector (layers 1–3), the gRPC API, or both.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"golang.org/x/sync/errgroup"

	apigrpc "github.com/yurasolovjov/dbperf/services/dbperf/internal/api/grpc"
	"github.com/yurasolovjov/dbperf/services/dbperf/internal/config"
	"github.com/yurasolovjov/dbperf/services/dbperf/internal/query"
	"github.com/yurasolovjov/dbperf/services/dbperf/internal/registry"
	"github.com/yurasolovjov/dbperf/services/dbperf/internal/scraper"
	chsink "github.com/yurasolovjov/dbperf/services/dbperf/internal/sink/clickhouse"
	"github.com/yurasolovjov/dbperf/services/dbperf/internal/telemetry"
)

func main() {
	var (
		cfgPath = flag.String("config", os.Getenv("DBPERF_CONFIG"), "path to config.yaml")
		role    = flag.String("role", "", "collector | api | all (overrides config)")
	)
	flag.Parse()
	cfg, err := config.Load(*cfgPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "config:", err)
		os.Exit(2)
	}
	if *role != "" {
		cfg.Role = config.Role(*role)
		if err := cfg.Validate(); err != nil {
			fmt.Fprintln(os.Stderr, "config:", err)
			os.Exit(2)
		}
	}
	if err := run(cfg); err != nil && !errors.Is(err, context.Canceled) {
		fmt.Fprintln(os.Stderr, "dbperf:", err)
		os.Exit(1)
	}
}

func run(cfg config.Config) error {
	log := telemetry.NewLogger(cfg.Log.Level, cfg.Log.Format)
	metrics := telemetry.NewMetrics()
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	log.Info("starting", "instance", cfg.Instance, "role", cfg.Role)

	conn, err := chsink.Open(ctx, cfg.ClickHouse)
	if err != nil {
		return err
	}
	defer conn.Close()

	source, lease, err := buildRegistry(ctx, cfg)
	if err != nil {
		return err
	}

	g, ctx := errgroup.WithContext(ctx)
	var status *registry.StatusStore
	collector := cfg.Role == config.RoleCollector || cfg.Role == config.RoleAll
	api := cfg.Role == config.RoleAPI || cfg.Role == config.RoleAll

	if collector {
		status = registry.NewStatusStore()
		sink := chsink.New(cfg.ClickHouse, conn, metrics, log.With("component", "sink"))
		scrapers := scraper.NewManager(cfg.Scraper, sink, status, metrics, log.With("component", "scraper"))
		manager := &registry.Manager{
			Source: source, Lease: lease, Instance: cfg.Instance,
			MaxTargets: cfg.Registry.MaxTargets, Refresh: cfg.Registry.Refresh, Renew: cfg.Registry.LeaseRenew,
			Assignee: scrapers, Log: log.With("component", "registry"),
		}
		g.Go(func() error { return sink.Run(ctx) })
		g.Go(func() error { return scrapers.Run(ctx) })
		g.Go(func() error { return manager.Run(ctx) })
		g.Go(func() error { return reportTargets(ctx, status, metrics) })
	}
	if api {
		srv := apigrpc.New(apigrpc.Deps{
			Query:     query.New(conn, cfg.ClickHouse, cfg.API.MaxPoints, cfg.Scraper.QueryMaxLen),
			Targets:   source,
			Status:    status,
			Instance:  cfg.Instance,
			Metrics:   metrics,
			Log:       log.With("component", "grpc"),
			MaxConc:   cfg.API.MaxConcurrentQueries,
			MaxPoints: cfg.API.MaxPoints,
		})
		g.Go(func() error { return srv.Run(ctx, cfg.API.GRPCAddr) })
	}
	g.Go(func() error {
		return telemetry.ServeHTTP(ctx, cfg.API.HTTPAddr, metrics, func() error {
			pctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			return conn.Ping(pctx)
		}, log.With("component", "http"))
	})
	err = g.Wait()
	log.Info("stopped")
	return err
}

func buildRegistry(ctx context.Context, cfg config.Config) (registry.TargetSource, registry.Lease, error) {
	switch cfg.Registry.Type {
	case "yaml":
		src := &registry.YAMLSource{
			Path:            cfg.Registry.YAMLPath,
			DefaultInterval: cfg.Scraper.DefaultInterval,
			DefaultTimeout:  cfg.Scraper.StatementTimeout,
		}
		if _, err := src.List(ctx); err != nil {
			return nil, nil, err
		}
		return src, registry.NewLocalLease(src), nil
	case "postgres":
		src := &registry.PostgresSource{
			DSN:             cfg.Registry.PostgresDSN,
			DefaultInterval: cfg.Scraper.DefaultInterval,
			DefaultTimeout:  cfg.Scraper.StatementTimeout,
			LeaseTTL:        cfg.Registry.LeaseTTL,
		}
		if err := src.EnsureSchema(ctx); err != nil {
			return nil, nil, err
		}
		return src, src, nil
	}
	return nil, nil, fmt.Errorf("registry type %q", cfg.Registry.Type)
}

// reportTargets publishes the number of targets per state every 10 seconds.
func reportTargets(ctx context.Context, status *registry.StatusStore, m *telemetry.Metrics) error {
	t := time.NewTicker(10 * time.Second)
	defer t.Stop()
	names := map[registry.State]string{
		registry.StateUnknown: "unknown", registry.StateConnected: "connected",
		registry.StateDisconnected: "disconnected", registry.StateDisabled: "disabled",
	}
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
			counts := status.Count()
			for st, name := range names {
				m.SetTargets(name, counts[st])
			}
		}
	}
}
