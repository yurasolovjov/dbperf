# Repo-level targets for the docker-compose bench in deploy/.
.PHONY: up down logs build-dbperf build-registry build-ui test test-ui

build-dbperf:
	$(MAKE) -C services/dbperf build-linux

build-registry:
	$(MAKE) -C services/registry build-linux

build-ui:
	cd services/dbperf-ui && npm ci --no-audit --no-fund && npm run build

up: build-dbperf build-registry build-ui
	docker compose -f deploy/docker-compose.yaml up --build -d

down:
	docker compose -f deploy/docker-compose.yaml down -v

logs:
	docker compose -f deploy/docker-compose.yaml logs -f --tail 100 dbperf dbperf-2 registry ui

test:
	$(MAKE) -C services/dbperf test
	$(MAKE) -C services/registry test
	$(MAKE) test-ui

test-ui:
	cd services/dbperf-ui && npm run test:coverage && npm run typecheck
