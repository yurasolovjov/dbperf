GOBIN ?= $(shell go env GOPATH)/bin
export PATH := $(PATH):$(GOBIN)

.PHONY: build build-linux test vet lint proto run up down load

build:
	go build ./...

test:
	go test ./...

vet:
	go vet ./...

lint:
	golangci-lint run ./...

proto:
	buf lint && buf generate

run:
	go run ./cmd/dbperf --config configs/config.example.yaml

build-linux:
	CGO_ENABLED=0 GOOS=linux GOARCH=$$(docker version --format '{{.Server.Arch}}') go build -trimpath -ldflags="-s -w" -o out/dbperf ./cmd/dbperf

up: build-linux
	docker compose -f deploy/docker-compose.yaml up --build -d

down:
	docker compose -f deploy/docker-compose.yaml down -v

# Synthetic load: 50 000 targets, 10 s interval, 8 active sessions each, 1 hour of data.
load:
	go run ./test/load --addr localhost:9000 --targets 50000 --interval 10s --active 8 --duration 1h
