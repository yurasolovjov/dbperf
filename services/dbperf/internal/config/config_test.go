package config

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestLoadDefaultsAndOverride(t *testing.T) {
	path := filepath.Join(t.TempDir(), "c.yaml")
	_ = os.WriteFile(path, []byte("instance: x\nclickhouse:\n  addrs: [\"ch:9000\"]\n  flush_rows: 5000\nscraper:\n  default_interval: 5s\n"), 0o600)
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Instance != "x" || cfg.ClickHouse.Addrs[0] != "ch:9000" || cfg.ClickHouse.FlushRows != 5000 {
		t.Fatalf("%+v", cfg.ClickHouse)
	}
	if cfg.Scraper.DefaultInterval != 5*time.Second || cfg.Scraper.StatementTimeout != 5*time.Second {
		t.Fatalf("%+v", cfg.Scraper)
	}
	if cfg.API.GRPCAddr != ":9090" {
		t.Fatalf("api default lost: %+v", cfg.API)
	}
}

func TestValidate(t *testing.T) {
	cfg := Default()
	cfg.Role = "nope"
	cfg.ClickHouse.FlushRows = 10
	cfg.Registry.LeaseRenew = cfg.Registry.LeaseTTL
	if err := cfg.Validate(); err == nil {
		t.Fatal("expected errors")
	}
}
