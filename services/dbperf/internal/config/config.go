// Package config loads and validates the dbperf configuration file.
package config

import (
	"errors"
	"fmt"
	"os"
	"time"

	"gopkg.in/yaml.v3"
)

// Role selects which layers a process runs.
type Role string

const (
	RoleCollector Role = "collector"
	RoleAPI       Role = "api"
	RoleAll       Role = "all"
)

// Config is the root configuration.
type Config struct {
	Instance   string     `yaml:"instance"`
	Role       Role       `yaml:"role"`
	Registry   Registry   `yaml:"registry"`
	Scraper    Scraper    `yaml:"scraper"`
	ClickHouse ClickHouse `yaml:"clickhouse"`
	API        API        `yaml:"api"`
	Log        Log        `yaml:"log"`
}

// Registry configures layer 1: where the list of targets comes from.
type Registry struct {
	Type        string        `yaml:"type"` // yaml | postgres | grpc
	YAMLPath    string        `yaml:"yaml_path"`
	PostgresDSN string        `yaml:"postgres_dsn"`
	Addr        string        `yaml:"addr"` // dbperf-registry gRPC address for type grpc
	MaxTargets  int           `yaml:"max_targets"`
	LeaseTTL    time.Duration `yaml:"lease_ttl"`
	LeaseRenew  time.Duration `yaml:"lease_renew"`
	Refresh     time.Duration `yaml:"refresh"`
}

// Scraper configures layer 2.
type Scraper struct {
	DefaultInterval  time.Duration `yaml:"default_interval"`
	StatementTimeout time.Duration `yaml:"statement_timeout"`
	ConnectTimeout   time.Duration `yaml:"connect_timeout"`
	QueryMaxLen      int           `yaml:"query_max_len"`
	QueryCacheSize   int           `yaml:"query_cache_size"`
	ReconnectMin     time.Duration `yaml:"reconnect_min"`
	ReconnectMax     time.Duration `yaml:"reconnect_max"`
}

// ClickHouse configures layer 3 and the read side.
type ClickHouse struct {
	Addrs             []string      `yaml:"addrs"`
	Database          string        `yaml:"database"`
	User              string        `yaml:"user"`
	Password          string        `yaml:"password"`
	FlushInterval     time.Duration `yaml:"flush_interval"`
	FlushRows         int           `yaml:"flush_rows"`
	MaxPendingBatches int           `yaml:"max_pending_batches"`
	DialTimeout       time.Duration `yaml:"dial_timeout"`
	MaxOpenConns      int           `yaml:"max_open_conns"`
	RawRangeLimit     time.Duration `yaml:"raw_range_limit"` // ranges longer than this use the 1m level
	RawStep           time.Duration `yaml:"raw_step"`        // smallest step of the raw level
}

// API configures the gRPC and HTTP listeners.
type API struct {
	GRPCAddr             string `yaml:"grpc_addr"`
	HTTPAddr             string `yaml:"http_addr"`
	MaxConcurrentQueries int    `yaml:"max_concurrent_queries"`
	MaxPoints            int    `yaml:"max_points"`
}

// Log configures logging.
type Log struct {
	Level  string `yaml:"level"`  // debug | info | warn | error
	Format string `yaml:"format"` // json | text
}

// Default returns a configuration with all defaults set.
func Default() Config {
	host, _ := os.Hostname()
	return Config{
		Instance: host,
		Role:     RoleAll,
		Registry: Registry{
			Type:       "yaml",
			YAMLPath:   "configs/targets.yaml",
			MaxTargets: 5000,
			LeaseTTL:   60 * time.Second,
			LeaseRenew: 20 * time.Second,
			Refresh:    30 * time.Second,
		},
		Scraper: Scraper{
			DefaultInterval:  10 * time.Second,
			StatementTimeout: 5 * time.Second,
			ConnectTimeout:   5 * time.Second,
			QueryMaxLen:      4096,
			QueryCacheSize:   10000,
			ReconnectMin:     time.Second,
			ReconnectMax:     60 * time.Second,
		},
		ClickHouse: ClickHouse{
			Addrs:             []string{"localhost:9000"},
			Database:          "dbperf",
			User:              "default",
			FlushInterval:     5 * time.Second,
			FlushRows:         40000,
			MaxPendingBatches: 10,
			DialTimeout:       5 * time.Second,
			MaxOpenConns:      8,
			RawRangeLimit:     2 * time.Hour,
			RawStep:           10 * time.Second,
		},
		API: API{
			GRPCAddr:             ":9090",
			HTTPAddr:             ":9091",
			MaxConcurrentQueries: 32,
			MaxPoints:            2000,
		},
		Log: Log{Level: "info", Format: "json"},
	}
}

// Load reads a YAML file on top of the defaults and validates the result.
// An empty path returns the defaults.
func Load(path string) (Config, error) {
	cfg := Default()
	if path != "" {
		data, err := os.ReadFile(path)
		if err != nil {
			return cfg, fmt.Errorf("read config: %w", err)
		}
		if err := yaml.Unmarshal(data, &cfg); err != nil {
			return cfg, fmt.Errorf("parse config: %w", err)
		}
	}
	if err := cfg.Validate(); err != nil {
		return cfg, err
	}
	return cfg, nil
}

// Validate checks the configuration for impossible values.
func (c Config) Validate() error {
	var errs []error
	switch c.Role {
	case RoleCollector, RoleAPI, RoleAll:
	default:
		errs = append(errs, fmt.Errorf("role: unknown value %q", c.Role))
	}
	if c.Instance == "" {
		errs = append(errs, errors.New("instance: must not be empty"))
	}
	switch c.Registry.Type {
	case "yaml":
		if c.Registry.YAMLPath == "" {
			errs = append(errs, errors.New("registry.yaml_path: required for type yaml"))
		}
	case "postgres":
		if c.Registry.PostgresDSN == "" {
			errs = append(errs, errors.New("registry.postgres_dsn: required for type postgres"))
		}
	case "grpc":
		if c.Registry.Addr == "" {
			errs = append(errs, errors.New("registry.addr: required for type grpc"))
		}
	default:
		errs = append(errs, fmt.Errorf("registry.type: unknown value %q", c.Registry.Type))
	}
	if c.Registry.MaxTargets <= 0 {
		errs = append(errs, errors.New("registry.max_targets: must be positive"))
	}
	if c.Registry.LeaseRenew >= c.Registry.LeaseTTL {
		errs = append(errs, errors.New("registry.lease_renew: must be shorter than lease_ttl"))
	}
	if c.Scraper.DefaultInterval < time.Second {
		errs = append(errs, errors.New("scraper.default_interval: must be at least 1s"))
	}
	if c.Scraper.QueryMaxLen < 64 {
		errs = append(errs, errors.New("scraper.query_max_len: must be at least 64"))
	}
	if len(c.ClickHouse.Addrs) == 0 {
		errs = append(errs, errors.New("clickhouse.addrs: at least one address"))
	}
	if c.ClickHouse.FlushRows < 1000 {
		errs = append(errs, errors.New("clickhouse.flush_rows: must be at least 1000"))
	}
	if c.ClickHouse.FlushInterval < time.Second {
		errs = append(errs, errors.New("clickhouse.flush_interval: must be at least 1s"))
	}
	if c.ClickHouse.RawStep < time.Second {
		errs = append(errs, errors.New("clickhouse.raw_step: must be at least 1s"))
	}
	if c.API.MaxConcurrentQueries <= 0 {
		errs = append(errs, errors.New("api.max_concurrent_queries: must be positive"))
	}
	return errors.Join(errs...)
}
