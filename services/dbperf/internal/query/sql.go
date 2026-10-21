package query

import (
	"fmt"
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
	var sb strings.Builder
	args := []any{targetID, rng.Start, rng.End}
	fmt.Fprintf(&sb, "target_id = ? AND %s >= ? AND %s < ?", lv.tsCol, lv.tsCol)
	if excludeSelf {
		sb.WriteString(" AND application_name != ?")
		args = append(args, selfApp)
	}
	for _, f := range filters {
		if len(f.Values) == 0 {
			continue
		}
		expr, err := dimExpr(f.Dim, lv)
		if err != nil {
			return "", nil, err
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
