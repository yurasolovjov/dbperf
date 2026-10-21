package scraper

import "container/list"

// hashLRU remembers which query hashes were already sent for a target.
type hashLRU struct {
	cap   int
	order *list.List
	m     map[uint64]*list.Element
}

func newHashLRU(capacity int) *hashLRU {
	if capacity <= 0 {
		capacity = 1
	}
	return &hashLRU{cap: capacity, order: list.New(), m: make(map[uint64]*list.Element, capacity)}
}

// Touch marks h as seen and reports whether it was new.
func (l *hashLRU) Touch(h uint64) bool {
	if e, ok := l.m[h]; ok {
		l.order.MoveToFront(e)
		return false
	}
	e := l.order.PushFront(h)
	l.m[h] = e
	if l.order.Len() > l.cap {
		last := l.order.Back()
		l.order.Remove(last)
		delete(l.m, last.Value.(uint64))
	}
	return true
}
