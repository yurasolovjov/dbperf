// Package lease holds the pure distribution rules: fair share and the
// gradual release of targets above it.
package lease

import "sort"

// FairShare is the number of targets one instance should run.
func FairShare(enabledTargets, liveInstances int, capacity int32) int32 {
	if liveInstances <= 0 {
		liveInstances = 1
	}
	share := (enabledTargets + liveInstances - 1) / liveInstances
	if capacity > 0 && int(capacity) < share {
		return capacity
	}
	return int32(share)
}

// ReleaseRequest picks the targets an instance should give back: the excess
// over the fair share, highest ids first, at most 10 % of what it owns per
// call. An excess below 5 % of the owned set is ignored, so large instances
// do not shuffle single targets back and forth; small sets always release.
func ReleaseRequest(owned []uint32, fairShare int32) []uint32 {
	excess := len(owned) - int(fairShare)
	if excess <= 0 || excess*20 < len(owned) { // < 5 %
		return nil
	}
	limit := len(owned) / 10
	if limit < 1 {
		limit = 1
	}
	if excess < limit {
		limit = excess
	}
	sorted := append([]uint32(nil), owned...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] > sorted[j] })
	return sorted[:limit]
}
