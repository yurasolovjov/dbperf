package lease

import "testing"

func TestFairShare(t *testing.T) {
	cases := []struct {
		targets, instances int
		capacity, want     int32
	}{
		{50000, 10, 5000, 5000},
		{50000, 9, 5000, 5000}, // capped by capacity
		{50000, 9, 6000, 5556}, // ceil
		{2, 2, 1, 1},
		{0, 3, 10, 0},
		{10, 0, 0, 10}, // no live instances: all to the caller
	}
	for _, c := range cases {
		if got := FairShare(c.targets, c.instances, c.capacity); got != c.want {
			t.Errorf("FairShare(%d,%d,%d)=%d want %d", c.targets, c.instances, c.capacity, got, c.want)
		}
	}
}

func TestReleaseRequest(t *testing.T) {
	owned := make([]uint32, 0, 100)
	for i := uint32(1); i <= 100; i++ {
		owned = append(owned, i)
	}
	if got := ReleaseRequest(owned, 99); got != nil {
		t.Fatalf("excess of 1 %% must be ignored, got %v", got)
	}
	if got := ReleaseRequest([]uint32{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11}, 10); len(got) != 1 || got[0] != 11 {
		t.Fatalf("small set must release its single excess target, got %v", got)
	}
	if got := ReleaseRequest(owned, 96); got != nil {
		t.Fatalf("excess below 5%% must be ignored, got %v", got)
	}
	got := ReleaseRequest(owned, 50)
	if len(got) != 10 || got[0] != 100 || got[9] != 91 {
		t.Fatalf("expected highest 10 ids, got %v", got)
	}
	got = ReleaseRequest(owned, 94)
	if len(got) != 6 {
		t.Fatalf("expected the whole excess of 6, got %v", got)
	}
	if got := ReleaseRequest([]uint32{1, 2, 3}, 1); len(got) != 1 || got[0] != 3 {
		t.Fatalf("small set: got %v", got)
	}
}
