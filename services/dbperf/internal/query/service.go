package query

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"

	"github.com/yurasolovjov/dbperf/services/dbperf/internal/config"
)

// Service runs dashboard queries against ClickHouse.
type Service struct {
	conn        driver.Conn
	db          string
	levels      []level
	maxPoints   int
	selfApp     string
	queryMaxLen int
}

// New creates a service over an open connection.
func New(conn driver.Conn, cfg config.ClickHouse, maxPoints, queryMaxLen int) *Service {
	return &Service{
		conn:        conn,
		db:          cfg.Database,
		levels:      []level{rawLevel(cfg.Database, cfg.RawStep, cfg.RawRangeLimit), minuteLevel(cfg.Database)},
		maxPoints:   maxPoints,
		selfApp:     "dbperf",
		queryMaxLen: queryMaxLen,
	}
}

const remainderValue = "other"

// TimeSeries implements GetActivityTimeSeries.
func (s *Service) TimeSeries(ctx context.Context, req TimeSeriesRequest) (*TimeSeriesResult, error) {
	if err := req.Range.Validate(); err != nil {
		return nil, invalid("%v", err)
	}
	if req.Slicing.Dim == DimUnspecified {
		return nil, invalid("slicing dimension is required")
	}
	limit := clampLimit(req.Slicing.Limit)
	maxPoints := s.points(req.MaxPoints)
	al, err := s.align(req.Range, req.Step, maxPoints, []Dimension{req.Slicing.Dim}, req.Filters)
	if err != nil {
		return nil, err
	}
	expr, err := dimExpr(req.Slicing.Dim, al.level)
	if err != nil {
		return nil, err
	}
	cond, args, err := where(al.level, req.TargetID, al.rng, req.Filters, req.ExcludeSelf, s.selfApp)
	if err != nil {
		return nil, err
	}
	stepSec := int(al.step.Seconds())

	samples, err := s.samplesPerBucket(ctx, al, req.TargetID)
	if err != nil {
		return nil, err
	}
	sql := fmt.Sprintf("SELECT %s AS bucket, %s AS slice, %s AS n FROM %s WHERE %s GROUP BY bucket, slice",
		bucketExpr(al.level, stepSec), expr, al.level.countExpr, al.level.activityTable, cond)
	rows, err := s.conn.Query(ctx, sql, args...)
	if err != nil {
		return nil, fmt.Errorf("activity query: %w", err)
	}
	defer rows.Close()
	type cell struct {
		bucket time.Time
		slice  string
		n      uint64
	}
	var cells []cell
	sliceTotal := map[string]uint64{}
	slicePeak := map[string]uint64{}
	for rows.Next() {
		var c cell
		if err := rows.Scan(&c.bucket, &c.slice, &c.n); err != nil {
			return nil, fmt.Errorf("activity scan: %w", err)
		}
		cells = append(cells, c)
		sliceTotal[c.slice] += c.n
		if c.n > slicePeak[c.slice] {
			slicePeak[c.slice] = c.n
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("activity rows: %w", err)
	}

	buckets := withSamples(al.buckets(), samples)
	index := make(map[time.Time]int, len(buckets))
	for i, b := range buckets {
		index[b] = i
	}
	top := topKeysSumAndPeak(sliceTotal, slicePeak, limit)
	topSet := make(map[string]int, len(top))
	for i, k := range top {
		topSet[k] = i
	}
	res := &TimeSeriesResult{
		Range: al.rng, Step: al.step, Level: al.level.name,
		Timestamps: buckets,
		Totals:     make([]float64, len(buckets)),
	}
	counts := make([][]uint64, len(top)+1) // last = remainder
	for i := range counts {
		counts[i] = make([]uint64, len(buckets))
	}
	totalCounts := make([]uint64, len(buckets))
	for _, c := range cells {
		i, ok := index[c.bucket]
		if !ok {
			continue
		}
		si, ok := topSet[c.slice]
		if !ok {
			si = len(top)
		}
		counts[si][i] += c.n
		totalCounts[i] += c.n
	}
	var sumSamples uint64
	for _, n := range samples {
		sumSamples += n
	}
	for i := range buckets {
		res.Totals[i] = ratio(totalCounts[i], samples[buckets[i]])
	}
	shorts, err := s.shortTexts(ctx, req.TargetID, req.Slicing.Dim, top)
	if err != nil {
		return nil, err
	}
	for si := 0; si <= len(top); si++ {
		sv := SliceValue{ID: uint32(si + 1)}
		var sum uint64
		if si < len(top) {
			sv.Value = top[si]
			sv.ShortText = shorts[top[si]]
		} else {
			sv.Value, sv.IsRemainder = remainderValue, true
		}
		ser := Series{Slice: sv, Values: make([]float64, len(buckets))}
		for i := range buckets {
			ser.Values[i] = ratio(counts[si][i], samples[buckets[i]])
			sum += counts[si][i]
		}
		ser.Average = ratio(sum, sumSamples)
		if si == len(top) && sum == 0 {
			continue // no remainder
		}
		res.Series = append(res.Series, ser)
	}
	return res, nil
}

// Totals implements GetActivityTotals.
func (s *Service) Totals(ctx context.Context, req TotalsRequest) (*TotalsResult, error) {
	if err := req.Range.Validate(); err != nil {
		return nil, invalid("%v", err)
	}
	al, err := s.align(req.Range, req.Step, s.points(req.MaxPoints), nil, req.Filters)
	if err != nil {
		return nil, err
	}
	cond, args, err := where(al.level, req.TargetID, al.rng, req.Filters, req.ExcludeSelf, s.selfApp)
	if err != nil {
		return nil, err
	}
	samples, err := s.samplesPerBucket(ctx, al, req.TargetID)
	if err != nil {
		return nil, err
	}
	sql := fmt.Sprintf("SELECT %s AS bucket, %s AS n FROM %s WHERE %s GROUP BY bucket",
		bucketExpr(al.level, int(al.step.Seconds())), al.level.countExpr, al.level.activityTable, cond)
	rows, err := s.conn.Query(ctx, sql, args...)
	if err != nil {
		return nil, fmt.Errorf("totals query: %w", err)
	}
	defer rows.Close()
	active := map[time.Time]uint64{}
	for rows.Next() {
		var b time.Time
		var n uint64
		if err := rows.Scan(&b, &n); err != nil {
			return nil, fmt.Errorf("totals scan: %w", err)
		}
		active[b] = n
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	buckets := withSamples(al.buckets(), samples)
	res := &TotalsResult{Step: al.step, Timestamps: buckets, Values: make([]float64, len(buckets))}
	var sumN, sumS uint64
	for i, b := range buckets {
		res.Values[i] = ratio(active[b], samples[b])
		sumN += active[b]
		sumS += samples[b]
	}
	res.Average = ratio(sumN, sumS)
	return res, nil
}

// Top implements GetActivityTop.
func (s *Service) Top(ctx context.Context, req TopRequest) (*TopResult, error) {
	if err := req.Range.Validate(); err != nil {
		return nil, invalid("%v", err)
	}
	if req.Slicing.Dim == DimUnspecified {
		return nil, invalid("slicing dimension is required")
	}
	if _, _, err := metricHaving(req.AAS, req.Percent, 0, 0); err != nil {
		return nil, err
	}
	limit := clampLimit(req.Slicing.Limit)
	if req.PageSize < 0 || req.PageSize > 100 || req.Offset < 0 || req.Offset > 1000000 {
		return nil, invalid("invalid pagination")
	}
	if req.PageSize > 0 {
		limit = req.PageSize
	}
	allFilters := append(append([]Filter{}, req.Filters...), req.TableFilters...)
	dims := []Dimension{req.Slicing.Dim}
	if req.SubSlicing != nil {
		dims = append(dims, req.SubSlicing.Dim)
	}
	al, err := s.align(req.Range, 0, s.maxPoints, dims, allFilters)
	if err != nil {
		return nil, err
	}
	lv := al.level
	expr, err := dimExpr(req.Slicing.Dim, lv)
	if err != nil {
		return nil, err
	}
	cond, args, err := where(lv, req.TargetID, al.rng, allFilters, req.ExcludeSelf, s.selfApp)
	if err != nil {
		return nil, err
	}
	nSamples, err := s.sampleCount(ctx, al, req.TargetID)
	if err != nil {
		return nil, err
	}
	var total uint64
	if err := s.conn.QueryRow(ctx, fmt.Sprintf("SELECT %s FROM %s WHERE %s", lv.countExpr, lv.activityTable, cond), args...).Scan(&total); err != nil {
		return nil, fmt.Errorf("top total: %w", err)
	}
	having, metricArgs, err := metricHaving(req.AAS, req.Percent, nSamples, total)
	if err != nil {
		return nil, err
	}
	grouped := fmt.Sprintf("SELECT %s AS slice, %s AS n FROM %s WHERE %s GROUP BY slice%s", expr, lv.countExpr, lv.activityTable, cond, having)
	queryArgs := append(append([]any{}, args...), metricArgs...)
	var matched uint64
	if err := s.conn.QueryRow(ctx, "SELECT count() FROM ("+grouped+")", queryArgs...).Scan(&matched); err != nil {
		return nil, fmt.Errorf("top count: %w", err)
	}
	sql := fmt.Sprintf("%s ORDER BY n DESC, slice LIMIT %d OFFSET %d", grouped, limit, req.Offset)
	rows, err := s.conn.Query(ctx, sql, queryArgs...)
	if err != nil {
		return nil, fmt.Errorf("top query: %w", err)
	}
	type kv struct {
		k string
		n uint64
	}
	var top []kv
	for rows.Next() {
		var r kv
		if err := rows.Scan(&r.k, &r.n); err != nil {
			rows.Close()
			return nil, fmt.Errorf("top scan: %w", err)
		}
		top = append(top, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	keys := make([]string, len(top))
	for i, r := range top {
		keys[i] = r.k
	}
	shorts, err := s.shortTexts(ctx, req.TargetID, req.Slicing.Dim, keys)
	if err != nil {
		return nil, err
	}
	res := &TopResult{MatchedRows: matched, Level: lv.name, TotalAAS: ratio(total, nSamples), NSamples: int64(nSamples)}
	var topSum uint64
	for i, r := range top {
		topSum += r.n
		res.Entries = append(res.Entries, TopEntry{
			Slice:   SliceValue{Value: r.k, ShortText: shorts[r.k], ID: uint32(i + 1)},
			AAS:     ratio(r.n, nSamples),
			Percent: percent(r.n, total),
		})
	}
	if rem := total - topSum; rem > 0 && req.PageSize == 0 && having == "" && req.Offset == 0 {
		res.Entries = append(res.Entries, TopEntry{
			Slice:   SliceValue{Value: remainderValue, IsRemainder: true, ID: uint32(len(top) + 1)},
			AAS:     ratio(rem, nSamples),
			Percent: percent(rem, total),
		})
	}
	if req.SubSlicing != nil && req.SubSlicing.Dim != DimUnspecified && len(keys) > 0 {
		if err := s.subSlices(ctx, lv, expr, cond, args, keys, *req.SubSlicing, nSamples, res); err != nil {
			return nil, err
		}
	}
	return res, nil
}

// subSlices fills Sub of each top entry with the nested dimension.
func (s *Service) subSlices(ctx context.Context, lv level, expr, cond string, args []any, keys []string, sub TopSlicing, nSamples uint64, res *TopResult) error {
	subExpr, err := dimExpr(sub.Dim, lv)
	if err != nil {
		return err
	}
	limit := clampLimit(sub.Limit)
	sql := fmt.Sprintf("SELECT %s AS slice, %s AS sub, %s AS n FROM %s WHERE %s AND %s IN (%s) GROUP BY slice, sub",
		expr, subExpr, lv.countExpr, lv.activityTable, cond, expr, placeholders(len(keys)))
	a := append(append([]any{}, args...), toAny(keys)...)
	rows, err := s.conn.Query(ctx, sql, a...)
	if err != nil {
		return fmt.Errorf("sub query: %w", err)
	}
	defer rows.Close()
	per := map[string]map[string]uint64{}
	for rows.Next() {
		var k, sk string
		var n uint64
		if err := rows.Scan(&k, &sk, &n); err != nil {
			return fmt.Errorf("sub scan: %w", err)
		}
		if per[k] == nil {
			per[k] = map[string]uint64{}
		}
		per[k][sk] += n
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for i := range res.Entries {
		e := &res.Entries[i]
		if e.Slice.IsRemainder {
			continue
		}
		m := per[e.Slice.Value]
		var total uint64
		for _, n := range m {
			total += n
		}
		top := topKeys(m, limit)
		var topSum uint64
		for j, k := range top {
			topSum += m[k]
			e.Sub = append(e.Sub, TopEntry{
				Slice:   SliceValue{Value: k, ID: uint32(j + 1)},
				AAS:     ratio(m[k], nSamples),
				Percent: percent(m[k], total),
			})
		}
		if rem := total - topSum; rem > 0 {
			e.Sub = append(e.Sub, TopEntry{
				Slice:   SliceValue{Value: remainderValue, IsRemainder: true, ID: uint32(len(top) + 1)},
				AAS:     ratio(rem, nSamples),
				Percent: percent(rem, total),
			})
		}
	}
	return nil
}

// Sessions implements ListSessions.
func (s *Service) Sessions(ctx context.Context, req SessionsRequest) (*SessionsResult, error) {
	if req.At.IsZero() {
		return nil, invalid("at is required")
	}
	limit := req.Limit
	if limit <= 0 || limit > 1000 {
		limit = 1000
	}
	lv := s.levels[0]
	var sampleTS time.Time
	err := s.conn.QueryRow(ctx,
		fmt.Sprintf("SELECT max(ts) FROM %s WHERE target_id = ? AND ts <= ? AND ts > ?", lv.samplesTable),
		req.TargetID, req.At, req.At.Add(-time.Hour)).Scan(&sampleTS)
	if err != nil {
		return nil, fmt.Errorf("sample lookup: %w", err)
	}
	if sampleTS.IsZero() || sampleTS.Unix() <= 0 {
		return &SessionsResult{}, nil
	}
	cond, args, err := whereAliased(lv, req.TargetID, Range{Start: sampleTS, End: sampleTS.Add(time.Second)}, req.Filters, false, s.selfApp, "a.")
	if err != nil {
		return nil, err
	}
	sql := fmt.Sprintf(`SELECT a.ts, a.pid, a.leader_pid, a.backend_type, a.datname, a.usename, a.application_name,
	    %s AS client_addr, a.state, a.wait_event_type, a.wait_event,
	    a.backend_start, a.xact_start, a.query_start, a.state_change, a.query_hash,
	    substring(t.query, 1, 64) AS query_short
	FROM %s a
	LEFT JOIN %s.pg_query_texts t ON t.target_id = a.target_id AND t.query_hash = a.query_hash
	WHERE %s ORDER BY a.pid LIMIT %d`, clientAddrExpr, lv.activityTable, s.db, cond, limit)
	rows, err := s.conn.Query(ctx, sql, args...)
	if err != nil {
		return nil, fmt.Errorf("sessions query: %w", err)
	}
	defer rows.Close()
	res := &SessionsResult{SampleTS: sampleTS}
	for rows.Next() {
		var r Session
		if err := rows.Scan(&r.TS, &r.PID, &r.LeaderPID, &r.BackendType, &r.Datname, &r.Usename, &r.ApplicationName,
			&r.ClientAddr, &r.State, &r.WaitEventType, &r.WaitEvent,
			&r.BackendStart, &r.XactStart, &r.QueryStart, &r.StateChange, &r.QueryHash, &r.QueryShort); err != nil {
			return nil, fmt.Errorf("sessions scan: %w", err)
		}
		res.Sessions = append(res.Sessions, r)
	}
	return res, rows.Err()
}

const clientAddrExpr = "if(a.client_addr = toIPv6('::'), 'local', replaceOne(toString(a.client_addr), '::ffff:', ''))"

// QueryText implements GetQueryText.
func (s *Service) QueryText(ctx context.Context, targetID uint32, hash uint64) (text string, lastSeen time.Time, truncated bool, err error) {
	err = s.conn.QueryRow(ctx,
		fmt.Sprintf("SELECT query, last_seen FROM %s.pg_query_texts WHERE target_id = ? AND query_hash = ? ORDER BY last_seen DESC LIMIT 1", s.db),
		targetID, hash).Scan(&text, &lastSeen)
	if err != nil {
		return "", time.Time{}, false, err
	}
	return text, lastSeen, len(text) >= s.queryMaxLen, nil
}

// samplesPerBucket returns the number of snapshots per bucket.
func (s *Service) samplesPerBucket(ctx context.Context, al alignment, targetID uint32) (map[time.Time]uint64, error) {
	lv := al.level
	sql := fmt.Sprintf("SELECT %s AS bucket, %s AS n FROM %s WHERE target_id = ? AND %s >= ? AND %s < ? GROUP BY bucket",
		bucketExpr(lv, int(al.step.Seconds())), lv.samplesExpr, lv.samplesTable, lv.tsCol, lv.tsCol)
	rows, err := s.conn.Query(ctx, sql, targetID, al.rng.Start, al.rng.End)
	if err != nil {
		return nil, fmt.Errorf("samples query: %w", err)
	}
	defer rows.Close()
	out := map[time.Time]uint64{}
	for rows.Next() {
		var b time.Time
		var n uint64
		if err := rows.Scan(&b, &n); err != nil {
			return nil, fmt.Errorf("samples scan: %w", err)
		}
		out[b] = n
	}
	return out, rows.Err()
}

func (s *Service) sampleCount(ctx context.Context, al alignment, targetID uint32) (uint64, error) {
	lv := al.level
	var n uint64
	err := s.conn.QueryRow(ctx,
		fmt.Sprintf("SELECT %s FROM %s WHERE target_id = ? AND %s >= ? AND %s < ?", lv.samplesExpr, lv.samplesTable, lv.tsCol, lv.tsCol),
		targetID, al.rng.Start, al.rng.End).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("sample count: %w", err)
	}
	return n, nil
}

// shortTexts returns the first 64 characters of query texts for the QUERY
// dimension; other dimensions get an empty map.
func (s *Service) shortTexts(ctx context.Context, targetID uint32, dim Dimension, keys []string) (map[string]string, error) {
	out := map[string]string{}
	if dim != DimQuery || len(keys) == 0 {
		return out, nil
	}
	hashes := make([]any, 0, len(keys))
	for _, k := range keys {
		h, err := strconv.ParseUint(k, 10, 64)
		if err != nil {
			continue
		}
		hashes = append(hashes, h)
	}
	if len(hashes) == 0 {
		return out, nil
	}
	sql := fmt.Sprintf("SELECT toString(query_hash), substring(anyLast(query), 1, 64) FROM %s.pg_query_texts WHERE target_id = ? AND query_hash IN (%s) GROUP BY query_hash",
		s.db, placeholders(len(hashes)))
	rows, err := s.conn.Query(ctx, sql, append([]any{targetID}, hashes...)...)
	if err != nil {
		return nil, fmt.Errorf("texts query: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		out[k] = v
	}
	return out, rows.Err()
}

// withSamples drops buckets without a single snapshot: a gap in collection is
// shown as a missing point, not as zero activity.
func withSamples(buckets []time.Time, samples map[time.Time]uint64) []time.Time {
	out := buckets[:0:0]
	for _, b := range buckets {
		if samples[b] > 0 {
			out = append(out, b)
		}
	}
	return out
}

func (s *Service) points(requested int) int {
	if requested <= 0 || requested > s.maxPoints {
		return s.maxPoints
	}
	return requested
}

func clampLimit(n int) int {
	if n <= 0 {
		return 10
	}
	if n > 100 {
		return 100
	}
	return n
}

func ratio(n, d uint64) float64 {
	if d == 0 {
		return 0
	}
	return round3(float64(n) / float64(d))
}

func percent(n, d uint64) float64 {
	if d == 0 {
		return 0
	}
	return round3(100 * float64(n) / float64(d))
}

func round3(v float64) float64 { return float64(int64(v*1000+0.5)) / 1000 }

func topKeys(m map[string]uint64, limit int) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		if m[keys[i]] != m[keys[j]] {
			return m[keys[i]] > m[keys[j]]
		}
		return keys[i] < keys[j]
	})
	if len(keys) > limit {
		keys = keys[:limit]
	}
	return keys
}

// topKeysSumAndPeak picks the slices shown as separate series of a time
// series. Ranking by the sum over the range alone hides a short burst: a query
// that ran for one bucket at a high rate has a small sum and lands in "other"
// even though it is the only thing visible in that bucket. So, when the limit
// allows it (limit >= 10; the proto has no top_by field and the UI asks for
// 10), the result is the union of the top by sum and the top by per-bucket
// peak: the top half of the limit by sum first, then the keys with the
// highest peak that are not yet taken, then the rest by sum until the limit
// is filled. Below the limit of 10 the ranking is by sum only. The returned
// order is by sum, so slice ids stay the same as before for the keys that
// were already in the top by sum.
func topKeysSumAndPeak(sum, peak map[string]uint64, limit int) []string {
	if limit < 10 || len(sum) <= limit {
		return topKeys(sum, limit)
	}
	bySum := topKeys(sum, len(sum))
	byPeak := topKeys(peak, len(peak))
	chosen := make(map[string]bool, limit)
	var out []string
	take := func(k string) {
		if !chosen[k] && len(out) < limit {
			chosen[k] = true
			out = append(out, k)
		}
	}
	for _, k := range bySum[:limit/2] {
		take(k)
	}
	for _, k := range byPeak {
		if len(out) >= limit {
			break
		}
		take(k)
	}
	for _, k := range bySum {
		if len(out) >= limit {
			break
		}
		take(k)
	}
	sort.Slice(out, func(i, j int) bool {
		if sum[out[i]] != sum[out[j]] {
			return sum[out[i]] > sum[out[j]]
		}
		return out[i] < out[j]
	})
	return out
}

func toAny(ss []string) []any {
	out := make([]any, len(ss))
	for i, s := range ss {
		out[i] = s
	}
	return out
}

// prefixCond qualifies bare column references of a WHERE clause with an alias.
func prefixCond(cond, alias string) string {
	for _, col := range []string{"target_id", "ts", "application_name", "wait_event_type", "wait_event", "query_hash", "client_addr", "usename", "datname", "backend_type", "pid"} {
		cond = replaceWord(cond, col, alias+col)
	}
	return cond
}

func replaceWord(s, word, repl string) string {
	var sb strings.Builder
	for i := 0; i < len(s); {
		j := strings.Index(s[i:], word)
		if j < 0 {
			sb.WriteString(s[i:])
			break
		}
		j += i
		before := j == 0 || !isWordByte(s[j-1])
		after := j+len(word) >= len(s) || !isWordByte(s[j+len(word)])
		sb.WriteString(s[i:j])
		if before && after {
			sb.WriteString(repl)
		} else {
			sb.WriteString(word)
		}
		i = j + len(word)
	}
	return sb.String()
}

func isWordByte(b byte) bool {
	return b == '_' || b == '.' || (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') || (b >= '0' && b <= '9')
}
