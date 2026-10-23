package grpc

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// PromMetrics implements Metrics with Prometheus.
type PromMetrics struct {
	reg       *prometheus.Registry
	changes   prometheus.Counter
	calls     *prometheus.CounterVec
	instances prometheus.Gauge
}

// NewPromMetrics registers the metrics.
func NewPromMetrics() *PromMetrics {
	m := &PromMetrics{reg: prometheus.NewRegistry()}
	m.changes = prometheus.NewCounter(prometheus.CounterOpts{Name: "registry_target_changes_total", Help: "create, update and delete calls"})
	m.calls = prometheus.NewCounterVec(prometheus.CounterOpts{Name: "registry_lease_calls_total", Help: "lease calls by method and result"}, []string{"method", "result"})
	m.instances = prometheus.NewGauge(prometheus.GaugeOpts{Name: "registry_instances", Help: "live dbperf instances"})
	m.reg.MustRegister(m.changes, m.calls, m.instances, collectors.NewGoCollector(), collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}))
	return m
}

func (m *PromMetrics) TargetsChanged() { m.changes.Inc() }
func (m *PromMetrics) LeaseCall(method string, err error) {
	res := "ok"
	if err != nil {
		res = "error"
	}
	m.calls.WithLabelValues(method, res).Inc()
}
func (m *PromMetrics) SetInstances(n int) { m.instances.Set(float64(n)) }

// Handler serves /metrics.
func (m *PromMetrics) Handler() http.Handler {
	return promhttp.HandlerFor(m.reg, promhttp.HandlerOpts{})
}
