// Package store is the only etcd client of the registry: targets, name
// uniqueness, the id counter, instance sessions and target ownership.
package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"go.etcd.io/etcd/api/v3/v3rpc/rpctypes"
	clientv3 "go.etcd.io/etcd/client/v3"
)

// Target is the stored monitored database.
type Target struct {
	ID                 uint32            `json:"id"`
	Name               string            `json:"name"`
	DSN                string            `json:"dsn"`
	IntervalSec        int32             `json:"interval_sec"`
	StatementTimeoutMs int32             `json:"statement_timeout_ms"`
	Enabled            bool              `json:"enabled"`
	Labels             map[string]string `json:"labels,omitempty"`
	CreatedAt          int64             `json:"created_at"`
	UpdatedAt          int64             `json:"updated_at"`
	Revision           int64             `json:"-"`
}

// Instance is a registered dbperf process.
type Instance struct {
	Name         string `json:"name"`
	Capacity     int32  `json:"capacity"`
	Version      string `json:"version"`
	RegisteredAt int64  `json:"registered_at"`
	LeaseID      int64  `json:"lease_id"`
	ExpiresAt    int64  `json:"-"`
}

// Owner is the holder of a target lease.
type Owner struct {
	Instance   string `json:"instance"`
	AcquiredAt int64  `json:"acquired_at"`
}

// Errors returned by the store.
var (
	ErrNotFound      = errors.New("not found")
	ErrAlreadyExists = errors.New("already exists")
	ErrRevision      = errors.New("revision mismatch")
	ErrConflict      = errors.New("transaction conflict")
	ErrSession       = errors.New("session expired")
)

// Store wraps an etcd client under one key prefix.
type Store struct {
	cli    *clientv3.Client
	prefix string
}

// New connects to etcd.
func New(ctx context.Context, endpoints []string, prefix string, dialTimeout time.Duration) (*Store, error) {
	cli, err := clientv3.New(clientv3.Config{Endpoints: endpoints, DialTimeout: dialTimeout, Context: ctx})
	if err != nil {
		return nil, fmt.Errorf("etcd connect: %w", err)
	}
	if !strings.HasSuffix(prefix, "/") {
		prefix += "/"
	}
	sctx, cancel := context.WithTimeout(ctx, dialTimeout)
	defer cancel()
	if _, err := cli.Status(sctx, endpoints[0]); err != nil {
		cli.Close()
		return nil, fmt.Errorf("etcd status: %w", err)
	}
	return &Store{cli: cli, prefix: prefix}, nil
}

// Close closes the client.
func (s *Store) Close() error { return s.cli.Close() }

func (s *Store) targetKey(id uint32) string { return fmt.Sprintf("%stargets/%010d", s.prefix, id) }
func (s *Store) nameKey(name string) string { return s.prefix + "names/" + name }
func (s *Store) ownerKey(id uint32) string  { return fmt.Sprintf("%sowners/%010d", s.prefix, id) }
func (s *Store) instKey(name string) string { return s.prefix + "instances/" + name }
func (s *Store) seqKey() string             { return s.prefix + "seq/target_id" }

func idFromKey(key string) uint32 {
	i := strings.LastIndex(key, "/")
	v, _ := strconv.ParseUint(key[i+1:], 10, 32)
	return uint32(v)
}

// ---------------------------------------------------------------- targets

// NextID allocates the next target id with a compare-and-swap loop.
func (s *Store) NextID(ctx context.Context) (uint32, error) {
	for attempt := 0; attempt < 10; attempt++ {
		resp, err := s.cli.Get(ctx, s.seqKey())
		if err != nil {
			return 0, err
		}
		var cur uint64
		var cmp clientv3.Cmp
		if len(resp.Kvs) == 0 {
			cmp = clientv3.Compare(clientv3.CreateRevision(s.seqKey()), "=", 0)
		} else {
			cur, _ = strconv.ParseUint(string(resp.Kvs[0].Value), 10, 64)
			cmp = clientv3.Compare(clientv3.ModRevision(s.seqKey()), "=", resp.Kvs[0].ModRevision)
		}
		next := cur + 1
		tx, err := s.cli.Txn(ctx).If(cmp).Then(clientv3.OpPut(s.seqKey(), strconv.FormatUint(next, 10))).Commit()
		if err != nil {
			return 0, err
		}
		if tx.Succeeded {
			return uint32(next), nil
		}
	}
	return 0, ErrConflict
}

// Create stores a new target. ID 0 allocates one; a given id must be free.
// The name must be free too; both checks are one transaction.
func (s *Store) Create(ctx context.Context, t Target) (Target, error) {
	if t.ID == 0 {
		id, err := s.NextID(ctx)
		if err != nil {
			return t, err
		}
		t.ID = id
	}
	now := time.Now().Unix()
	t.CreatedAt, t.UpdatedAt = now, now
	data, _ := json.Marshal(t)
	tx, err := s.cli.Txn(ctx).
		If(clientv3.Compare(clientv3.CreateRevision(s.nameKey(t.Name)), "=", 0),
			clientv3.Compare(clientv3.CreateRevision(s.targetKey(t.ID)), "=", 0)).
		Then(clientv3.OpPut(s.targetKey(t.ID), string(data)),
			clientv3.OpPut(s.nameKey(t.Name), strconv.FormatUint(uint64(t.ID), 10))).
		Commit()
	if err != nil {
		return t, err
	}
	if !tx.Succeeded {
		return t, ErrAlreadyExists
	}
	t.Revision = tx.Header.Revision
	return t, nil
}

// Get returns a target by id.
func (s *Store) Get(ctx context.Context, id uint32) (Target, error) {
	resp, err := s.cli.Get(ctx, s.targetKey(id))
	if err != nil {
		return Target{}, err
	}
	if len(resp.Kvs) == 0 {
		return Target{}, ErrNotFound
	}
	return decodeTarget(resp.Kvs[0].Value, resp.Kvs[0].ModRevision)
}

// GetByName resolves a name and returns the target.
func (s *Store) GetByName(ctx context.Context, name string) (Target, error) {
	resp, err := s.cli.Get(ctx, s.nameKey(name))
	if err != nil {
		return Target{}, err
	}
	if len(resp.Kvs) == 0 {
		return Target{}, ErrNotFound
	}
	return s.Get(ctx, idFromKey("/"+string(resp.Kvs[0].Value)))
}

// List returns every target ordered by id and the revision of the read.
func (s *Store) List(ctx context.Context) ([]Target, int64, error) {
	resp, err := s.cli.Get(ctx, s.prefix+"targets/", clientv3.WithPrefix(), clientv3.WithSort(clientv3.SortByKey, clientv3.SortAscend))
	if err != nil {
		return nil, 0, err
	}
	out := make([]Target, 0, len(resp.Kvs))
	for _, kv := range resp.Kvs {
		t, err := decodeTarget(kv.Value, kv.ModRevision)
		if err != nil {
			continue
		}
		out = append(out, t)
	}
	return out, resp.Header.Revision, nil
}

// Update replaces a target. expectedRev 0 skips the optimistic check. A name
// change moves the name key; disabling a target drops its owner.
func (s *Store) Update(ctx context.Context, t Target, expectedRev int64) (Target, error) {
	cur, err := s.Get(ctx, t.ID)
	if err != nil {
		return t, err
	}
	if expectedRev != 0 && cur.Revision != expectedRev {
		return t, ErrRevision
	}
	t.CreatedAt = cur.CreatedAt
	t.UpdatedAt = time.Now().Unix()
	data, _ := json.Marshal(t)
	cmps := []clientv3.Cmp{clientv3.Compare(clientv3.ModRevision(s.targetKey(t.ID)), "=", cur.Revision)}
	ops := []clientv3.Op{clientv3.OpPut(s.targetKey(t.ID), string(data))}
	if t.Name != cur.Name {
		cmps = append(cmps, clientv3.Compare(clientv3.CreateRevision(s.nameKey(t.Name)), "=", 0))
		ops = append(ops, clientv3.OpDelete(s.nameKey(cur.Name)), clientv3.OpPut(s.nameKey(t.Name), strconv.FormatUint(uint64(t.ID), 10)))
	}
	if !t.Enabled {
		ops = append(ops, clientv3.OpDelete(s.ownerKey(t.ID)))
	}
	tx, err := s.cli.Txn(ctx).If(cmps...).Then(ops...).Commit()
	if err != nil {
		return t, err
	}
	if !tx.Succeeded {
		if t.Name != cur.Name {
			return t, ErrAlreadyExists
		}
		return t, ErrRevision
	}
	t.Revision = tx.Header.Revision
	return t, nil
}

// Delete removes the target, its name and its owner.
func (s *Store) Delete(ctx context.Context, id uint32) error {
	cur, err := s.Get(ctx, id)
	if err != nil {
		return err
	}
	_, err = s.cli.Txn(ctx).Then(
		clientv3.OpDelete(s.targetKey(id)),
		clientv3.OpDelete(s.nameKey(cur.Name)),
		clientv3.OpDelete(s.ownerKey(id)),
	).Commit()
	return err
}

// Event is one change of the targets prefix.
type Event struct {
	Deleted  bool
	ID       uint32
	Target   Target
	Revision int64
}

// Watch streams target changes from a revision (0 = now) until ctx ends.
func (s *Store) Watch(ctx context.Context, sinceRev int64) <-chan Event {
	out := make(chan Event, 64)
	opts := []clientv3.OpOption{clientv3.WithPrefix()}
	if sinceRev > 0 {
		opts = append(opts, clientv3.WithRev(sinceRev+1))
	}
	wch := s.cli.Watch(ctx, s.prefix+"targets/", opts...)
	go func() {
		defer close(out)
		for wr := range wch {
			if wr.Err() != nil {
				return
			}
			for _, ev := range wr.Events {
				e := Event{ID: idFromKey(string(ev.Kv.Key)), Revision: ev.Kv.ModRevision}
				if ev.Type == clientv3.EventTypeDelete {
					e.Deleted = true
				} else if t, err := decodeTarget(ev.Kv.Value, ev.Kv.ModRevision); err == nil {
					e.Target = t
				}
				select {
				case out <- e:
				case <-ctx.Done():
					return
				}
			}
		}
	}()
	return out
}

func decodeTarget(b []byte, rev int64) (Target, error) {
	var t Target
	if err := json.Unmarshal(b, &t); err != nil {
		return t, err
	}
	t.Revision = rev
	return t, nil
}

// ---------------------------------------------------------------- sessions and owners

// Register opens a session for an instance: a lease with ttl and the
// instance key attached to it. An existing session of the same instance is
// revoked first, which frees its targets.
func (s *Store) Register(ctx context.Context, inst Instance, ttl time.Duration) (Instance, error) {
	if old, err := s.GetInstance(ctx, inst.Name); err == nil && old.LeaseID != 0 {
		_, _ = s.cli.Revoke(ctx, clientv3.LeaseID(old.LeaseID))
	}
	lease, err := s.cli.Grant(ctx, int64(ttl.Seconds()))
	if err != nil {
		return inst, err
	}
	inst.LeaseID = int64(lease.ID)
	inst.RegisteredAt = time.Now().Unix()
	data, _ := json.Marshal(inst)
	if _, err := s.cli.Put(ctx, s.instKey(inst.Name), string(data), clientv3.WithLease(lease.ID)); err != nil {
		return inst, err
	}
	inst.ExpiresAt = inst.RegisteredAt + int64(ttl.Seconds())
	return inst, nil
}

// GetInstance reads an instance and its lease deadline.
func (s *Store) GetInstance(ctx context.Context, name string) (Instance, error) {
	resp, err := s.cli.Get(ctx, s.instKey(name))
	if err != nil {
		return Instance{}, err
	}
	if len(resp.Kvs) == 0 {
		return Instance{}, ErrNotFound
	}
	var inst Instance
	if err := json.Unmarshal(resp.Kvs[0].Value, &inst); err != nil {
		return inst, err
	}
	if ttl, err := s.cli.TimeToLive(ctx, clientv3.LeaseID(inst.LeaseID)); err == nil && ttl.TTL > 0 {
		inst.ExpiresAt = time.Now().Unix() + ttl.TTL
	}
	return inst, nil
}

// Instances lists live instances.
func (s *Store) Instances(ctx context.Context) ([]Instance, error) {
	resp, err := s.cli.Get(ctx, s.prefix+"instances/", clientv3.WithPrefix())
	if err != nil {
		return nil, err
	}
	out := make([]Instance, 0, len(resp.Kvs))
	for _, kv := range resp.Kvs {
		var inst Instance
		if err := json.Unmarshal(kv.Value, &inst); err != nil {
			continue
		}
		if ttl, err := s.cli.TimeToLive(ctx, clientv3.LeaseID(inst.LeaseID)); err == nil && ttl.TTL > 0 {
			inst.ExpiresAt = time.Now().Unix() + ttl.TTL
		}
		out = append(out, inst)
	}
	return out, nil
}

// CheckSession verifies that the instance's current session is leaseID.
func (s *Store) CheckSession(ctx context.Context, instance string, leaseID int64) error {
	inst, err := s.GetInstance(ctx, instance)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return ErrSession
		}
		return err
	}
	if inst.LeaseID != leaseID {
		return ErrSession
	}
	return nil
}

// KeepAlive renews the session lease once and returns the remaining TTL in seconds.
func (s *Store) KeepAlive(ctx context.Context, leaseID int64) (int64, error) {
	resp, err := s.cli.KeepAliveOnce(ctx, clientv3.LeaseID(leaseID))
	if err != nil {
		if errors.Is(err, rpctypes.ErrLeaseNotFound) || strings.Contains(err.Error(), "lease not found") {
			return 0, ErrSession
		}
		return 0, err
	}
	return resp.TTL, nil
}

// Revoke ends a session; etcd deletes every key attached to the lease.
func (s *Store) Revoke(ctx context.Context, leaseID int64) error {
	_, err := s.cli.Revoke(ctx, clientv3.LeaseID(leaseID))
	return err
}

// Owners returns target id → owner for every leased target.
func (s *Store) Owners(ctx context.Context) (map[uint32]Owner, error) {
	resp, err := s.cli.Get(ctx, s.prefix+"owners/", clientv3.WithPrefix())
	if err != nil {
		return nil, err
	}
	out := make(map[uint32]Owner, len(resp.Kvs))
	for _, kv := range resp.Kvs {
		var o Owner
		if err := json.Unmarshal(kv.Value, &o); err != nil {
			continue
		}
		out[idFromKey(string(kv.Key))] = o
	}
	return out, nil
}

// Acquire tries to take each id for the instance; a target already owned
// is skipped. Each take is a compare-and-swap, so two instances never share one.
func (s *Store) Acquire(ctx context.Context, instance string, leaseID int64, ids []uint32) ([]uint32, error) {
	taken := make([]uint32, 0, len(ids))
	for _, id := range ids {
		val, _ := json.Marshal(Owner{Instance: instance, AcquiredAt: time.Now().Unix()})
		tx, err := s.cli.Txn(ctx).
			If(clientv3.Compare(clientv3.CreateRevision(s.ownerKey(id)), "=", 0),
				clientv3.Compare(clientv3.CreateRevision(s.targetKey(id)), ">", 0)).
			Then(clientv3.OpPut(s.ownerKey(id), string(val), clientv3.WithLease(clientv3.LeaseID(leaseID)))).
			Commit()
		if err != nil {
			return taken, err
		}
		if tx.Succeeded {
			taken = append(taken, id)
		}
	}
	return taken, nil
}

// Release deletes owner keys that belong to the instance.
func (s *Store) Release(ctx context.Context, instance string, ids []uint32) (int, error) {
	released := 0
	for _, id := range ids {
		resp, err := s.cli.Get(ctx, s.ownerKey(id))
		if err != nil {
			return released, err
		}
		if len(resp.Kvs) == 0 {
			continue
		}
		var o Owner
		if json.Unmarshal(resp.Kvs[0].Value, &o) != nil || o.Instance != instance {
			continue
		}
		tx, err := s.cli.Txn(ctx).
			If(clientv3.Compare(clientv3.ModRevision(s.ownerKey(id)), "=", resp.Kvs[0].ModRevision)).
			Then(clientv3.OpDelete(s.ownerKey(id))).Commit()
		if err != nil {
			return released, err
		}
		if tx.Succeeded {
			released++
		}
	}
	return released, nil
}
