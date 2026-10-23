// Command registryctl manages targets in dbperf-registry over gRPC.
//
//	registryctl -addr localhost:9100 import -file deploy/dbperf/targets.yaml
//	registryctl list | create | enable | disable | delete | assignments
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"strings"
	"text/tabwriter"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/fieldmaskpb"
	"gopkg.in/yaml.v3"

	registryv1 "github.com/yurasolovjov/dbperf/services/registry/gen/dbperf/registry/v1"
)

func main() {
	addr := flag.String("addr", envOr("REGISTRY_ADDR", "localhost:9100"), "registry gRPC address")
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "usage: registryctl [-addr host:port] <import|list|create|enable|disable|delete|assignments> [flags]\n")
	}
	flag.Parse()
	if flag.NArg() == 0 {
		flag.Usage()
		os.Exit(2)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	conn, err := grpc.NewClient(*addr, grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithDefaultCallOptions(grpc.WaitForReady(true))) // the bench starts registryctl right after the registry
	if err != nil {
		fail(err)
	}
	defer conn.Close()
	targets := registryv1.NewTargetRegistryClient(conn)
	leases := registryv1.NewLeaseServiceClient(conn)
	args := flag.Args()[1:]
	switch flag.Arg(0) {
	case "import":
		cmdImport(ctx, targets, args)
	case "list":
		cmdList(ctx, targets)
	case "create":
		cmdCreate(ctx, targets, args)
	case "enable", "disable":
		cmdEnable(ctx, targets, args, flag.Arg(0) == "enable")
	case "delete":
		cmdDelete(ctx, targets, args)
	case "assignments":
		cmdAssignments(ctx, leases)
	default:
		flag.Usage()
		os.Exit(2)
	}
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "registryctl:", err)
	os.Exit(1)
}

// targetsFile is the YAML layout of deploy/dbperf/targets.yaml.
type targetsFile struct {
	Targets []struct {
		ID               uint32            `yaml:"id"`
		Name             string            `yaml:"name"`
		DSN              string            `yaml:"dsn"`
		Interval         time.Duration     `yaml:"interval"`
		StatementTimeout time.Duration     `yaml:"statement_timeout"`
		Enabled          *bool             `yaml:"enabled"`
		Labels           map[string]string `yaml:"labels"`
	} `yaml:"targets"`
}

func cmdImport(ctx context.Context, c registryv1.TargetRegistryClient, args []string) {
	fs := flag.NewFlagSet("import", flag.ExitOnError)
	file := fs.String("file", "targets.yaml", "YAML file with targets")
	_ = fs.Parse(args)
	data, err := os.ReadFile(*file)
	if err != nil {
		fail(err)
	}
	var f targetsFile
	if err := yaml.Unmarshal(data, &f); err != nil {
		fail(err)
	}
	created, skipped := 0, 0
	for _, t := range f.Targets {
		req := &registryv1.CreateTargetRequest{
			TargetId: t.ID, Name: t.Name, Dsn: t.DSN,
			IntervalSec: int32(t.Interval.Seconds()), StatementTimeoutMs: int32(t.StatementTimeout.Milliseconds()),
			Labels: t.Labels,
		}
		if t.Enabled != nil {
			req.Enabled = t.Enabled
		}
		res, err := c.CreateTarget(ctx, req)
		if err != nil {
			if status.Code(err) == codes.AlreadyExists {
				fmt.Printf("skip %-24s already exists\n", t.Name)
				skipped++
				continue
			}
			fail(err)
		}
		fmt.Printf("created %-24s id=%d\n", res.GetName(), res.GetTargetId())
		created++
	}
	fmt.Printf("imported: %d created, %d skipped\n", created, skipped)
}

func cmdList(ctx context.Context, c registryv1.TargetRegistryClient) {
	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "ID\tNAME\tENABLED\tINTERVAL\tLABELS\tDSN")
	var token string
	for {
		resp, err := c.ListTargets(ctx, &registryv1.ListTargetsRequest{PageSize: 1000, PageToken: token})
		if err != nil {
			fail(err)
		}
		for _, t := range resp.GetTargets() {
			fmt.Fprintf(w, "%d\t%s\t%v\t%ds\t%s\t%s\n", t.GetTargetId(), t.GetName(), t.GetEnabled(), t.GetIntervalSec(), labels(t.GetLabels()), redact(t.GetDsn()))
		}
		if resp.GetNextPageToken() == "" {
			break
		}
		token = resp.GetNextPageToken()
	}
	_ = w.Flush()
}

func cmdCreate(ctx context.Context, c registryv1.TargetRegistryClient, args []string) {
	fs := flag.NewFlagSet("create", flag.ExitOnError)
	name := fs.String("name", "", "unique name")
	dsn := fs.String("dsn", "", "postgres://…")
	interval := fs.Int("interval", 10, "snapshot interval, seconds")
	labelsFlag := fs.String("labels", "", "k=v,k=v")
	_ = fs.Parse(args)
	req := &registryv1.CreateTargetRequest{Name: *name, Dsn: *dsn, IntervalSec: int32(*interval), Labels: parseLabels(*labelsFlag)}
	res, err := c.CreateTarget(ctx, req)
	if err != nil {
		fail(err)
	}
	fmt.Printf("created %s id=%d\n", res.GetName(), res.GetTargetId())
}

func cmdEnable(ctx context.Context, c registryv1.TargetRegistryClient, args []string, enabled bool) {
	fs := flag.NewFlagSet("enable", flag.ExitOnError)
	id := fs.Uint("id", 0, "target id")
	_ = fs.Parse(args)
	res, err := c.UpdateTarget(ctx, &registryv1.UpdateTargetRequest{
		Target:     &registryv1.Target{TargetId: uint32(*id), Enabled: enabled},
		UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"enabled"}},
	})
	if err != nil {
		fail(err)
	}
	fmt.Printf("%s enabled=%v\n", res.GetName(), res.GetEnabled())
}

func cmdDelete(ctx context.Context, c registryv1.TargetRegistryClient, args []string) {
	fs := flag.NewFlagSet("delete", flag.ExitOnError)
	id := fs.Uint("id", 0, "target id")
	_ = fs.Parse(args)
	if _, err := c.DeleteTarget(ctx, &registryv1.DeleteTargetRequest{TargetId: uint32(*id)}); err != nil {
		fail(err)
	}
	fmt.Printf("deleted id=%d\n", *id)
}

func cmdAssignments(ctx context.Context, c registryv1.LeaseServiceClient) {
	resp, err := c.ListAssignments(ctx, &registryv1.ListAssignmentsRequest{})
	if err != nil {
		fail(err)
	}
	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "INSTANCE\tCAPACITY\tEXPIRES_IN\tTARGETS")
	now := time.Now().Unix()
	for _, in := range resp.GetInstances() {
		fmt.Fprintf(w, "%s\t%d\t%ds\t%v\n", in.GetInstance(), in.GetCapacity(), in.GetExpiresAt()-now, in.GetTargetIds())
	}
	_ = w.Flush()
	if len(resp.GetUnassigned()) > 0 {
		fmt.Printf("unassigned: %v\n", resp.GetUnassigned())
	}
}

func parseLabels(s string) map[string]string {
	out := map[string]string{}
	for _, kv := range strings.Split(s, ",") {
		if k, v, ok := strings.Cut(kv, "="); ok {
			out[strings.TrimSpace(k)] = strings.TrimSpace(v)
		}
	}
	return out
}

func labels(m map[string]string) string {
	parts := make([]string, 0, len(m))
	for k, v := range m {
		parts = append(parts, k+"="+v)
	}
	return strings.Join(parts, ",")
}

// redact hides the password of a DSN in listings.
func redact(dsn string) string {
	at := strings.LastIndex(dsn, "@")
	colon := strings.Index(dsn, "://")
	if at < 0 || colon < 0 {
		return dsn
	}
	cred := dsn[colon+3 : at]
	if i := strings.Index(cred, ":"); i >= 0 {
		return dsn[:colon+3] + cred[:i] + ":***" + dsn[at:]
	}
	return dsn
}
