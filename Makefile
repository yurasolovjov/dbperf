# Repo-level targets for the docker-compose bench in deploy/.
.PHONY: up down logs build-dbperf build-ui test

build-dbperf:
	$(MAKE) -C services/dbperf build-linux

build-ui:
	cd services/dbperf-ui && npm ci --no-audit --no-fund && npm run build

up: build-dbperf build-ui
	docker compose -f deploy/docker-compose.yaml up --build -d

down:
	docker compose -f deploy/docker-compose.yaml down -v

logs:
	docker compose -f deploy/docker-compose.yaml logs -f --tail 100 dbperf ui

test:
	$(MAKE) -C services/dbperf test
	cd services/dbperf-ui && npm run typecheck
