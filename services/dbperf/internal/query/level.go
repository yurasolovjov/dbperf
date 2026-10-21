package query

import (
	"time"
)

// level is one storage tier.
type level struct {
	name          string
	step          time.Duration // smallest bucket
	rangeLimit    time.Duration // 0 = unlimited
	activityTable string
	samplesTable  string
	tsCol         string
	countExpr     string // activity rows per group
	samplesExpr   string // samples per bucket
	activeExpr    string // active rows per bucket (samples table)
	hasPID        bool
}

func rawLevel(db string, step, limit time.Duration) level {
	return level{
		name: "raw", step: step, rangeLimit: limit,
		activityTable: db + ".pg_activity", samplesTable: db + ".pg_samples",
		tsCol: "ts", countExpr: "count()", samplesExpr: "count()", activeExpr: "sum(n_active)", hasPID: true,
	}
}

func minuteLevel(db string) level {
	return level{
		name: "1m", step: time.Minute,
		activityTable: db + ".pg_activity_1m", samplesTable: db + ".pg_samples_1m",
		tsCol: "minute", countExpr: "sum(n_elements)", samplesExpr: "sum(n_samples)", activeExpr: "sum(n_active)",
	}
}

// alignment is the chosen level, step and aligned range.
type alignment struct {
	level  level
	step   time.Duration
	rng    Range
	points int
}

// chooseLevel picks the level that yields the most points within maxPoints,
// preferring the coarser level on a tie (the Kintsugi rule). The requested
// step is rounded up to a multiple of the level step; when no level fits,
// the minute level is used with a step large enough for maxPoints.
func chooseLevel(rng Range, requested time.Duration, maxPoints int, levels []level) alignment {
	var best *alignment
	for _, lv := range levels {
		a := alignFor(rng, requested, lv)
		if lv.rangeLimit > 0 && a.rng.End.Sub(a.rng.Start) > lv.rangeLimit {
			continue
		}
		if a.points > maxPoints {
			continue
		}
		if best == nil || a.points >= best.points { // later levels are coarser: they win ties
			b := a
			best = &b
		}
	}
	if best != nil {
		return *best
	}
	// Nothing fits: coarsest level, step grown to respect maxPoints.
	lv := levels[len(levels)-1]
	span := rng.End.Sub(rng.Start)
	step := (span / time.Duration(maxPoints)).Round(lv.step)
	if step < lv.step {
		step = lv.step
	}
	step = ceilTo(step, lv.step)
	for alignFor(rng, step, lv).points > maxPoints {
		step += lv.step
	}
	return alignFor(rng, step, lv)
}

func alignFor(rng Range, requested time.Duration, lv level) alignment {
	step := ceilTo(requested, lv.step)
	if step < lv.step {
		step = lv.step
	}
	start := rng.Start.Truncate(step)
	end := rng.End.Truncate(step)
	if end.Before(rng.End) {
		end = end.Add(step)
	}
	return alignment{
		level:  lv,
		step:   step,
		rng:    Range{Start: start, End: end},
		points: int(end.Sub(start) / step),
	}
}

func ceilTo(d, unit time.Duration) time.Duration {
	if d <= 0 {
		return unit
	}
	if r := d % unit; r != 0 {
		return d + unit - r
	}
	return d
}

// buckets lists the bucket starts of an alignment.
func (a alignment) buckets() []time.Time {
	out := make([]time.Time, 0, a.points)
	for t := a.rng.Start; t.Before(a.rng.End); t = t.Add(a.step) {
		out = append(out, t)
	}
	return out
}
