GOBIN ?= $(shell go env GOPATH)/bin
export PATH := $(PATH):$(GOBIN)

.PHONY: build test test-etcd vet proto build-linux

build:
	go build ./...

test:
	go test ./...

# Integration tests against a throwaway etcd container on :12379.
test-etcd:
	docker rm -f dbperf-etcd-test >/dev/null 2>&1 || true
	docker run -d --name dbperf-etcd-test -p 12379:2379 quay.io/coreos/etcd:v3.5.21 etcd --listen-client-urls http://0.0.0.0:2379 --advertise-client-urls http://0.0.0.0:2379 >/dev/null
	sleep 2
	ETCD_ENDPOINTS=localhost:12379 go test -count=1 ./... ; status=$$?; docker rm -f dbperf-etcd-test >/dev/null; exit $$status

vet:
	go vet ./...

proto:
	buf lint && buf generate

build-linux:
	CGO_ENABLED=0 GOOS=linux GOARCH=$$(docker version --format '{{.Server.Arch}}') go build -trimpath -ldflags="-s -w" -o out/registry ./cmd/registry
	CGO_ENABLED=0 GOOS=linux GOARCH=$$(docker version --format '{{.Server.Arch}}') go build -trimpath -ldflags="-s -w" -o out/registryctl ./cmd/registryctl
