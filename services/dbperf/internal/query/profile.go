package query

import (
	"context"
	"fmt"
	"strings"
)

// Profile implements GetActivityProfile: GROUP BY the requested dimensions in
// order and count rows. The client builds the tree; here only the flat paths.
func (s *Service) Profile(ctx context.Context, req ProfileRequest) (*ProfileResult, error) {
	if err := req.Range.Validate(); err != nil {
		return nil, invalid("%v", err)
	}
	if len(req.Dimensions) == 0 || len(req.Dimensions) > 6 {
		return nil, invalid("dimensions: 1 to 6 required")
	}
	seen := map[Dimension]bool{}
	for _, d := range req.Dimensions {
		if seen[d] {
			return nil, invalid("dimensions: %s repeated", d)
		}
		seen[d] = true
	}
	maxPaths := req.MaxPaths
	if maxPaths <= 0 || maxPaths > 20000 {
		maxPaths = 5000
	}
	minSamples := max(req.MinSamples, 1)

	al := chooseLevel(req.Range, 0, s.maxPoints, s.levels)
	lv := al.level
	exprs := make([]string, len(req.Dimensions))
	cols := make([]string, len(req.Dimensions))
	for i, d := range req.Dimensions {
		e, err := dimExpr(d, lv)
		if err != nil {
			return nil, err
		}
		cols[i] = fmt.Sprintf("d%d", i)
		exprs[i] = fmt.Sprintf("%s AS %s", e, cols[i])
	}
	cond, args, err := where(lv, req.TargetID, al.rng, req.Filters, req.ExcludeSelf, s.selfApp)
	if err != nil {
		return nil, err
	}
	nSamples, err := s.sampleCount(ctx, al, req.TargetID)
	if err != nil {
		return nil, err
	}
	var total uint64
	if err := s.conn.QueryRow(ctx, fmt.Sprintf("SELECT %s FROM %s WHERE %s", lv.countExpr, lv.activityTable, cond), args...).Scan(&total); err != nil {
		return nil, fmt.Errorf("profile total: %w", err)
	}
	sql := fmt.Sprintf("SELECT %s, %s AS n FROM %s WHERE %s GROUP BY %s HAVING n >= %d ORDER BY n DESC, %s LIMIT %d",
		strings.Join(exprs, ", "), lv.countExpr, lv.activityTable, cond, strings.Join(cols, ", "), minSamples, strings.Join(cols, ", "), maxPaths)
	rows, err := s.conn.Query(ctx, sql, args...)
	if err != nil {
		return nil, fmt.Errorf("profile query: %w", err)
	}
	defer rows.Close()
	res := &ProfileResult{NSamples: nSamples, TotalSamples: total, Level: lv.name, QueryTexts: map[string]string{}}
	queryCols := []int{}
	for i, d := range req.Dimensions {
		if d == DimQuery {
			queryCols = append(queryCols, i)
		}
	}
	hashes := map[string]bool{}
	for rows.Next() {
		vals := make([]string, len(req.Dimensions))
		dest := make([]any, 0, len(vals)+1)
		for i := range vals {
			dest = append(dest, &vals[i])
		}
		var n uint64
		dest = append(dest, &n)
		if err := rows.Scan(dest...); err != nil {
			return nil, fmt.Errorf("profile scan: %w", err)
		}
		for _, qc := range queryCols {
			hashes[vals[qc]] = true
		}
		res.Paths = append(res.Paths, ProfilePath{Values: vals, Samples: n})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(hashes) > 0 {
		keys := make([]string, 0, len(hashes))
		for k := range hashes {
			keys = append(keys, k)
		}
		texts, err := s.shortTexts(ctx, req.TargetID, DimQuery, keys)
		if err != nil {
			return nil, err
		}
		res.QueryTexts = texts
	}
	return res, nil
}
