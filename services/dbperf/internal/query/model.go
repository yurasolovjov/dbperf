// Package query is the read side: it turns dashboard requests into ClickHouse
// SQL over the dbperf tables and shapes the results into slices.
package query

import (
	"errors"
	"fmt"
	"time"
)

// Dimension is a slice of activity.
type Dimension int

// Dimensions, mirroring dbperf.v1.Dimension.
const (
	DimUnspecified Dimension = iota
	DimWaitEventType
	DimWaitEvent
	DimQuery
	DimClientAddr
	DimUsename
	DimDatname
	DimPID
	DimApplicationName
	DimBackendType
)

func (d Dimension) String() string {
	switch d {
	case DimWaitEventType:
		return "wait_event_type"
	case DimWaitEvent:
		return "wait_event"
	case DimQuery:
		return "query"
	case DimClientAddr:
		return "client_addr"
	case DimUsename:
		return "usename"
	case DimDatname:
		return "datname"
	case DimPID:
		return "pid"
	case DimApplicationName:
		return "application_name"
	case DimBackendType:
		return "backend_type"
	}
	return "unspecified"
}

// Filter keeps (or excludes) rows whose dimension value is in Values.
type Filter struct {
	Dim     Dimension
	Values  []string
	Exclude bool
	Match   int // 0 values, 1 contains, 2 text equals
}

// TopSlicing asks for the Limit largest values of a dimension.
type TopSlicing struct {
	Dim   Dimension
	Limit int
}

// Range is [Start, End).
type Range struct {
	Start, End time.Time
}

// Validate checks the range.
func (r Range) Validate() error {
	if r.Start.IsZero() || r.End.IsZero() {
		return errors.New("range: start and end are required")
	}
	if !r.End.After(r.Start) {
		return errors.New("range: end must be after start")
	}
	if r.End.Sub(r.Start) > 30*24*time.Hour {
		return errors.New("range: longer than 30 days")
	}
	return nil
}

// SliceValue identifies one value of a dimension in a response.
type SliceValue struct {
	Value       string
	ShortText   string
	IsRemainder bool
	ID          uint32
}

// TimeSeriesRequest asks for activity per bucket sliced by a dimension.
type TimeSeriesRequest struct {
	TargetID    uint32
	Range       Range
	Step        time.Duration
	Slicing     TopSlicing
	Filters     []Filter
	ExcludeSelf bool
	MaxPoints   int
}

// Series is one slice value over the buckets.
type Series struct {
	Slice   SliceValue
	Values  []float64
	Average float64
}

// TimeSeriesResult is the aligned answer.
type TimeSeriesResult struct {
	Range      Range
	Step       time.Duration
	Level      string
	Timestamps []time.Time
	Totals     []float64
	Series     []Series
}

type MetricRange struct {
	Min, Max *float64
}

// TopRequest asks for the top values over a window with an optional nested slice.
type TopRequest struct {
	TableFilters     []Filter
	AAS, Percent     *MetricRange
	PageSize, Offset int
	TargetID         uint32
	Range            Range
	Slicing          TopSlicing
	SubSlicing       *TopSlicing
	Filters          []Filter
	ExcludeSelf      bool
}

// TopEntry is one row of the top table.
type TopEntry struct {
	Slice   SliceValue
	AAS     float64
	Percent float64
	Sub     []TopEntry
}

// TopResult is the top table.
type TopResult struct {
	MatchedRows uint64
	Level       string
	TotalAAS    float64
	NSamples    int64
	Entries     []TopEntry
}

// TotalsRequest asks for unsliced activity per bucket.
type TotalsRequest struct {
	TargetID    uint32
	Range       Range
	Step        time.Duration
	Filters     []Filter
	ExcludeSelf bool
	MaxPoints   int
}

// TotalsResult is the unsliced series.
type TotalsResult struct {
	Step       time.Duration
	Timestamps []time.Time
	Values     []float64
	Average    float64
}

// SessionsRequest asks for the raw rows of one sample.
type SessionsRequest struct {
	TargetID uint32
	At       time.Time
	Filters  []Filter
	Limit    int
}

// Session is one raw row.
type Session struct {
	TS              time.Time
	PID             int32
	LeaderPID       int32
	BackendType     string
	Datname         string
	Usename         string
	ApplicationName string
	ClientAddr      string
	State           string
	WaitEventType   string
	WaitEvent       string
	BackendStart    time.Time
	XactStart       time.Time
	QueryStart      time.Time
	StateChange     time.Time
	QueryHash       uint64
	QueryShort      string
}

// SessionsResult is one sample.
type SessionsResult struct {
	SampleTS time.Time
	Sessions []Session
}

// ErrInvalid marks a request error (maps to INVALID_ARGUMENT).
var ErrInvalid = errors.New("invalid request")

func invalid(format string, a ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalid, fmt.Sprintf(format, a...))
}

// ProfileRequest asks for sample counts along an ordered path of dimensions.
type ProfileRequest struct {
	TargetID    uint32
	Range       Range
	Dimensions  []Dimension
	Filters     []Filter
	ExcludeSelf bool
	MinSamples  int
	MaxPaths    int
}

// ProfilePath is one leaf of the profile.
type ProfilePath struct {
	Values  []string
	Samples uint64
}

// ProfileResult is the flame graph input.
type ProfileResult struct {
	NSamples     uint64
	TotalSamples uint64
	Level        string
	Paths        []ProfilePath
	QueryTexts   map[string]string
}
