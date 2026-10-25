package query

import (
	"fmt"
	"math"
	"strings"
)

// dimExpr returns the SQL expression of a dimension for a level.
func dimExpr(d Dimension, lv level) (string, error) {
	switch d {
	case DimWaitEventType:
		return "wait_event_type", nil
	case DimWaitEvent:
		return "if(wait_event_type = 'CPU', 'CPU', concat(wait_event_type, '.', wait_event))", nil
	case DimQuery:
		return "toString(query_hash)", nil
	case DimClientAddr:
		return "if(client_addr = toIPv6('::'), 'local', replaceOne(toString(client_addr), '::ffff:', ''))", nil
	case DimUsename:
		return "usename", nil
	case DimDatname:
		return "datname", nil
	case DimApplicationName:
		return "application_name", nil
	case DimBackendType:
		return "backend_type", nil
	case DimPID:
		if !lv.hasPID {
			return "", invalid("dimension pid is available only for ranges up to the raw level limit")
		}
		return "toString(pid)", nil
	}
	return "", invalid("dimension is required")
}

// where builds the common WHERE clause. Arguments are returned in order.
func where(lv level, targetID uint32, rng Range, filters []Filter, excludeSelf bool, selfApp string) (string, []any, error) {
	return whereAliased(lv, targetID, rng, filters, excludeSelf, selfApp, "")
}

func whereAliased(lv level, targetID uint32, rng Range, filters []Filter, excludeSelf bool, selfApp, alias string) (string, []any, error) {
	var sb strings.Builder
	args := []any{targetID, rng.Start, rng.End}
	fmt.Fprintf(&sb, "%starget_id = ? AND %s%s >= ? AND %s%s < ?", alias, alias, lv.tsCol, alias, lv.tsCol)
	if excludeSelf {
		sb.WriteString(" AND " + alias + "application_name != ?")
		args = append(args, selfApp)
	}
	if len(filters) > 64 {
		return "", nil, invalid("too many filters")
	}
	for _, f := range filters {
		if f.Match < 0 || f.Match > 2 || len(f.Values) > 100 {
			return "", nil, invalid("invalid filter")
		}
		for _, v := range f.Values {
			if len(v) > 4096 {
				return "", nil, invalid("filter value too long")
			}
		}
		if len(f.Values) == 0 {
			continue
		}
		expr, err := dimExpr(f.Dim, lv)
		if err != nil {
			return "", nil, err
		}

		if alias != "" {
			expr = prefixCond(expr, alias)
		}
		if f.Match != 0 {
			terms := make([]string, 0, len(f.Values))
			textExpr := expr
			if f.Dim == DimQuery {
				textExpr = "text"
				args = append(args, targetID)
			}
			for _, v := range f.Values {
				if f.Match == 1 {
					terms = append(terms, "positionCaseInsensitiveUTF8("+textExpr+", ?) > 0")
				} else {
					terms = append(terms, "lowerUTF8("+textExpr+") = lowerUTF8(?)")
				}
				args = append(args, v)
			}
			predicate := "(" + strings.Join(terms, " OR ") + ")"
			if f.Dim == DimQuery {
				// Latest texts are reduced by hash before matching: no duplicate activity rows.
				db := strings.SplitN(lv.activityTable, ".", 2)[0]
				predicate = "toString(" + alias + "query_hash) IN (SELECT toString(query_hash) FROM (SELECT query_hash, argMax(query, last_seen) AS text FROM " + db + ".pg_query_texts WHERE target_id = ? GROUP BY query_hash) WHERE " + predicate + ")"
			}
			if f.Exclude {
				predicate = "NOT (" + predicate + ")"
			}
			sb.WriteString(" AND " + predicate)
			continue
		}
		op := "IN"
		if f.Exclude {
			op = "NOT IN"
		}
		fmt.Fprintf(&sb, " AND %s %s (%s)", expr, op, placeholders(len(f.Values)))
		for _, v := range f.Values {
			args = append(args, v)
		}
	}
	return sb.String(), args, nil
}

func placeholders(n int) string {
	if n <= 0 {
		return "NULL"
	}
	return strings.TrimSuffix(strings.Repeat("?, ", n), ", ")
}

// bucketExpr groups a time column into buckets of step seconds.
func bucketExpr(lv level, stepSec int) string {
	return fmt.Sprintf("toStartOfInterval(%s, INTERVAL %d SECOND)", lv.tsCol, stepSec)
}

// Metric predicates use the context denominator, before hiding groups.
func metricHaving(aas, pct *MetricRange, samples, total uint64) (string, []any, error) {
	var terms []string
	var args []any
	for _, m := range []struct {
		r            *MetricRange
		denom        uint64
		scale, upper float64
	}{
		{aas, samples, 1, math.Inf(1)}, {pct, total, 100, 100},
	} {
		if m.r == nil {
			continue
		}
		if m.r.Min != nil && m.r.Max != nil && *m.r.Min > *m.r.Max {
			return "", nil, invalid("metric min exceeds max")
		}
		for _, b := range []struct {
			v  *float64
			op string
		}{{m.r.Min, ">="}, {m.r.Max, "<="}} {
			if b.v == nil {
				continue
			}
			if math.IsNaN(*b.v) || math.IsInf(*b.v, 0) || *b.v < 0 || *b.v > m.upper {
				return "", nil, invalid("invalid metric bound")
			}
			terms = append(terms, "if(? = 0, 0., ? * n / ?) "+b.op+" ?")
			args = append(args, m.denom, m.scale, m.denom, *b.v)
		}
	}
	if len(terms) == 0 {
		return "", args, nil
	}
	return " HAVING " + strings.Join(terms, " AND "), args, nil
}
