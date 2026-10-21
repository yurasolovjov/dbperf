// Package scraper is layer 2: one pgconn connection per target, a periodic
// query to pg_stat_activity, rows handed to the sink.
package scraper

import (
	"hash/fnv"
	"net/netip"
	"time"
)

// ActivityRow is one active backend from a snapshot of pg_stat_activity.
type ActivityRow struct {
	TargetID        uint32
	TS              time.Time
	PID             int32
	LeaderPID       int32
	BackendType     string
	Datname         string
	Usename         string
	ApplicationName string
	ClientAddr      netip.Addr // zero value for a unix socket
	State           string
	WaitEventType   string
	WaitEvent       string
	BackendStart    time.Time
	XactStart       time.Time
	QueryStart      time.Time
	StateChange     time.Time
	QueryHash       uint64
	QueryText       string // filled only when the hash is new for the target
}

// SampleMarker is written once per snapshot, even when no row is active.
type SampleMarker struct {
	TargetID   uint32
	TS         time.Time
	NActive    uint16
	DurationMs uint16
}

// QueryText is a new (target, hash) pair seen by the scraper.
type QueryText struct {
	TargetID  uint32
	QueryHash uint64
	Query     string
	LastSeen  time.Time
}

// Batch is the output of one snapshot.
type Batch struct {
	Marker SampleMarker
	Rows   []ActivityRow
	Texts  []QueryText
}

// Emitter receives batches; implemented by the ClickHouse sink.
type Emitter interface {
	Emit(b Batch)
}

// CPU is the wait type and wait event assigned to a process that is active
// and not waiting on anything.
const CPU = "CPU"

// ApplyCPURule implements the Kintsugi rule: an active backend with neither
// wait_event_type nor wait_event is on CPU.
func ApplyCPURule(state string, waitEventType, waitEvent *string) (string, string) {
	if waitEventType == nil && waitEvent == nil && state == "active" {
		return CPU, CPU
	}
	wt, we := "", ""
	if waitEventType != nil {
		wt = *waitEventType
	}
	if waitEvent != nil {
		we = *waitEvent
	}
	return wt, we
}

// HashQuery computes the query hash for servers without compute_query_id:
// FNV-1a over the query text (64 bit).
func HashQuery(text string) uint64 {
	h := fnv.New64a()
	_, _ = h.Write([]byte(text))
	return h.Sum64()
}
