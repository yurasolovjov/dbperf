// Command load writes synthetic pg_stat_activity samples for many targets
// straight into the sink, bypassing PostgreSQL, to size ClickHouse.
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"net/netip"
	"os"
	"os/signal"
	"syscall"
	"time"

	"golang.org/x/sync/errgroup"

	"github.com/yurasolovjov/dbperf/services/dbperf/internal/config"
	"github.com/yurasolovjov/dbperf/services/dbperf/internal/scraper"
	chsink "github.com/yurasolovjov/dbperf/services/dbperf/internal/sink/clickhouse"
	"github.com/yurasolovjov/dbperf/services/dbperf/internal/telemetry"
)

func main() {
	var (
		addr     = flag.String("addr", "localhost:9000", "ClickHouse native address")
		database = flag.String("database", "dbperf", "database")
		targets  = flag.Int("targets", 50000, "number of synthetic targets")
		interval = flag.Duration("interval", 10*time.Second, "snapshot interval")
		active   = flag.Float64("active", 8, "mean active sessions per snapshot")
		duration = flag.Duration("duration", time.Hour, "wall-clock span of generated data")
		speed    = flag.Float64("speed", 60, "generation speed: how many data seconds per real second")
		workers  = flag.Int("workers", 10, "collector instances to emulate (one sink each)")
	)
	flag.Parse()
	cfg := config.Default().ClickHouse
	cfg.Addrs = []string{*addr}
	cfg.Database = *database
	log := telemetry.NewLogger("info", "text")
	metrics := telemetry.NewMetrics()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	conn, err := chsink.Open(ctx, cfg)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	g, gctx := errgroup.WithContext(ctx)
	perWorker := *targets / *workers
	for w := 0; w < *workers; w++ {
		sink := chsink.New(cfg, conn, metrics, log.With("worker", w))
		first := uint32(w*perWorker + 1)
		g.Go(func() error { return sink.Run(gctx) })
		g.Go(func() error {
			return generate(gctx, sink, first, perWorker, *interval, *active, *duration, *speed, log.With("worker", w))
		})
	}
	g.Go(func() error { return telemetry.ServeHTTP(gctx, ":9092", metrics, func() error { return nil }, log) })
	if err := g.Wait(); err != nil && ctx.Err() == nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

var (
	waitTypes = []string{"CPU", "CPU", "CPU", "CPU", "Lock", "LWLock", "IO", "Client", "IPC"}
	waitEvt   = map[string][]string{
		"CPU": {"CPU"}, "Lock": {"transactionid", "tuple", "relation"}, "LWLock": {"WALWrite", "BufferContent"},
		"IO": {"DataFileRead", "WALSync"}, "Client": {"ClientWrite"}, "IPC": {"ParallelFinish"},
	}
	users = []string{"app_api", "app_worker", "report", "postgres"}
	dbs   = []string{"shop", "billing", "postgres"}
	apps  = []string{"api", "worker", "psql", "pgbench"}
)

func generate(ctx context.Context, sink *chsink.Sink, first uint32, n int, interval time.Duration, active float64, span time.Duration, speed float64, log *slog.Logger) error {
	start := time.Now().UTC().Add(-span).Truncate(time.Second)
	end := start.Add(span)
	ticks := int(span / interval)
	realTick := time.Duration(float64(interval) / speed)
	ticker := time.NewTicker(realTick)
	defer ticker.Stop()
	queries := make([]uint64, 200)
	for i := range queries {
		queries[i] = rand.Uint64()
	}
	for ts := start; ts.Before(end); ts = ts.Add(interval) {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
		for i := 0; i < n; i++ {
			id := first + uint32(i)
			// Poisson-ish count around the mean, capped
			k := int(rand.ExpFloat64() * active)
			if k > 200 {
				k = 200
			}
			b := scraper.Batch{Marker: scraper.SampleMarker{TargetID: id, TS: ts, NActive: uint16(k), DurationMs: uint16(1 + rand.IntN(20))}}
			for j := 0; j < k; j++ {
				wt := waitTypes[rand.IntN(len(waitTypes))]
				q := queries[rand.IntN(len(queries))]
				b.Rows = append(b.Rows, scraper.ActivityRow{
					TargetID: id, TS: ts, PID: int32(1000 + rand.IntN(5000)),
					BackendType: "client backend", Datname: dbs[rand.IntN(len(dbs))], Usename: users[rand.IntN(len(users))],
					ApplicationName: apps[rand.IntN(len(apps))],
					ClientAddr:      netip.AddrFrom4([4]byte{10, 0, byte(rand.IntN(4)), byte(rand.IntN(250))}),
					State:           "active", WaitEventType: wt, WaitEvent: waitEvt[wt][rand.IntN(len(waitEvt[wt]))],
					BackendStart: ts.Add(-time.Hour), XactStart: ts.Add(-time.Duration(rand.IntN(5000)) * time.Millisecond),
					QueryStart: ts.Add(-time.Duration(rand.IntN(3000)) * time.Millisecond), StateChange: ts,
					QueryHash: q,
				})
				if ts.Equal(start) && j < 3 {
					b.Texts = append(b.Texts, scraper.QueryText{TargetID: id, QueryHash: q, Query: fmt.Sprintf("SELECT * FROM t%d WHERE id = $1", q%97), LastSeen: ts})
				}
			}
			sink.Emit(b)
		}
		if done := int(ts.Sub(start)/interval) + 1; done%60 == 0 {
			log.Info("progress", "ticks", done, "of", ticks, "data_time", ts)
		}
	}
	log.Info("generation finished")
	<-ctx.Done()
	return ctx.Err()
}
