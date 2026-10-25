package query

import "time"

// Requests that mention PID must read raw activity, even when a coarse chart
// step would otherwise make chooseLevel prefer the minute rollup on a tie.
func (s *Service) align(rng Range, step time.Duration, points int, dims []Dimension, filters []Filter) (alignment, error) {
	needsPID := false
	for _, d := range dims {
		needsPID = needsPID || d == DimPID
	}
	for _, f := range filters {
		needsPID = needsPID || f.Dim == DimPID && len(f.Values) > 0
	}
	if !needsPID {
		return chooseLevel(rng, step, points, s.levels), nil
	}
	al := chooseLevel(rng, step, points, s.levels[:1])
	if limit := al.level.rangeLimit; limit > 0 && al.rng.End.Sub(al.rng.Start) > limit {
		return alignment{}, invalid("PID is unavailable for this period; shorten the period or remove the PID filter")
	}
	return al, nil
}
