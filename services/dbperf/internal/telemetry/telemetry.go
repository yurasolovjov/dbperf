// Package telemetry holds Prometheus metrics, the logger and the HTTP
// endpoint for /metrics and /healthz.
package telemetry

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Metrics implements scraper.Metrics and sink Metrics.
type Metrics struct {
	reg *prometheus.Registry

	scrapeDuration *prometheus.HistogramVec
	scrapeRows     prometheus.Counter
	scrapeErrors   prometheus.Counter
	sinkRows       *prometheus.CounterVec
	sinkBatches    *prometheus.CounterVec
	sinkDropped    prometheus.Counter
	sinkPending    prometheus.Gauge
	sinkQueue      prometheus.Gauge
	apiRequests    *prometheus.CounterVec
	apiDuration    *prometheus.HistogramVec
	targets        *prometheus.GaugeVec
}

// NewMetrics registers all metrics in a fresh registry.
func NewMetrics() *Metrics {
	m := &Metrics{reg: prometheus.NewRegistry()}
	m.scrapeDuration = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Name: "dbperf_scrape_duration_seconds", Help: "pg_stat_activity query duration",
		Buckets: []float64{.005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5},
	}, []string{"result"})
	m.scrapeRows = prometheus.NewCounter(prometheus.CounterOpts{Name: "dbperf_scrape_rows_total", Help: "active rows collected"})
	m.scrapeErrors = prometheus.NewCounter(prometheus.CounterOpts{Name: "dbperf_scrape_errors_total", Help: "failed snapshots"})
	m.sinkRows = prometheus.NewCounterVec(prometheus.CounterOpts{Name: "dbperf_sink_rows_total", Help: "rows written to ClickHouse"}, []string{"table"})
	m.sinkBatches = prometheus.NewCounterVec(prometheus.CounterOpts{Name: "dbperf_sink_batches_total", Help: "inserts by table and result"}, []string{"table", "result"})
	m.sinkDropped = prometheus.NewCounter(prometheus.CounterOpts{Name: "dbperf_sink_dropped_rows_total", Help: "rows dropped because the pending queue was full"})
	m.sinkPending = prometheus.NewGauge(prometheus.GaugeOpts{Name: "dbperf_sink_pending_batches", Help: "batches waiting for a successful insert"})
	m.sinkQueue = prometheus.NewGauge(prometheus.GaugeOpts{Name: "dbperf_sink_buffered_rows", Help: "rows in the open buffer"})
	m.apiRequests = prometheus.NewCounterVec(prometheus.CounterOpts{Name: "dbperf_api_requests_total", Help: "gRPC requests by method and code"}, []string{"method", "code"})
	m.apiDuration = prometheus.NewHistogramVec(prometheus.HistogramOpts{Name: "dbperf_api_duration_seconds", Help: "gRPC handler duration", Buckets: prometheus.DefBuckets}, []string{"method"})
	m.targets = prometheus.NewGaugeVec(prometheus.GaugeOpts{Name: "dbperf_targets", Help: "targets by state on this instance"}, []string{"state"})
	m.reg.MustRegister(m.scrapeDuration, m.scrapeRows, m.scrapeErrors, m.sinkRows, m.sinkBatches,
		m.sinkDropped, m.sinkPending, m.sinkQueue, m.apiRequests, m.apiDuration, m.targets,
		collectors.NewGoCollector(), collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}))
	return m
}

// ObserveScrape implements scraper.Metrics.
func (m *Metrics) ObserveScrape(_ uint32, d time.Duration, rows int, err error) {
	if err != nil {
		m.scrapeDuration.WithLabelValues("error").Observe(d.Seconds())
		m.scrapeErrors.Inc()
		return
	}
	m.scrapeDuration.WithLabelValues("ok").Observe(d.Seconds())
	m.scrapeRows.Add(float64(rows))
}

// ObserveFlush records one insert attempt.
func (m *Metrics) ObserveFlush(table string, rows int, err error) {
	if err != nil {
		m.sinkBatches.WithLabelValues(table, "error").Inc()
		return
	}
	m.sinkBatches.WithLabelValues(table, "ok").Inc()
	m.sinkRows.WithLabelValues(table).Add(float64(rows))
}

// SetPending records the pending queue length.
func (m *Metrics) SetPending(n int) { m.sinkPending.Set(float64(n)) }

// SetBuffered records the open buffer size.
func (m *Metrics) SetBuffered(n int) { m.sinkQueue.Set(float64(n)) }

// AddDropped counts dropped rows.
func (m *Metrics) AddDropped(n int) { m.sinkDropped.Add(float64(n)) }

// ObserveAPI records one gRPC call.
func (m *Metrics) ObserveAPI(method, code string, d time.Duration) {
	m.apiRequests.WithLabelValues(method, code).Inc()
	m.apiDuration.WithLabelValues(method).Observe(d.Seconds())
}

// SetTargets records the number of targets by state.
func (m *Metrics) SetTargets(state string, n int) { m.targets.WithLabelValues(state).Set(float64(n)) }

// Handler returns the /metrics handler.
func (m *Metrics) Handler() http.Handler { return promhttp.HandlerFor(m.reg, promhttp.HandlerOpts{}) }

// NewLogger builds a slog logger from the config values.
func NewLogger(level, format string) *slog.Logger {
	var lvl slog.Level
	switch strings.ToLower(level) {
	case "debug":
		lvl = slog.LevelDebug
	case "warn":
		lvl = slog.LevelWarn
	case "error":
		lvl = slog.LevelError
	default:
		lvl = slog.LevelInfo
	}
	opts := &slog.HandlerOptions{Level: lvl}
	if format == "text" {
		return slog.New(slog.NewTextHandler(os.Stderr, opts))
	}
	return slog.New(slog.NewJSONHandler(os.Stderr, opts))
}

// Health is a function reporting readiness.
type Health func() error

// ServeHTTP runs the metrics and health endpoint until ctx is cancelled.
// Extra routes (the JSON API) are registered by the mount functions.
func ServeHTTP(ctx context.Context, addr string, m *Metrics, health Health, log *slog.Logger, mounts ...func(*http.ServeMux)) error {
	mux := http.NewServeMux()
	for _, mount := range mounts {
		mount(mux)
	}
	mux.Handle("/metrics", m.Handler())
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		if err := health(); err != nil {
			http.Error(w, err.Error(), http.StatusServiceUnavailable)
			return
		}
		_, _ = w.Write([]byte("ok\n"))
	})
	srv := &http.Server{Addr: addr, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	errc := make(chan error, 1)
	go func() { errc <- srv.ListenAndServe() }()
	log.Info("http listening", "addr", addr)
	select {
	case <-ctx.Done():
		sctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = srv.Shutdown(sctx)
		return ctx.Err()
	case err := <-errc:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}
