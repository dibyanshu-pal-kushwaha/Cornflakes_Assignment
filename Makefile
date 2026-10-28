.PHONY: all test verify chaos load seed docker-up docker-down clean

all: test

# Run all automated integration & trap test suites
test:
	npm run test

# Verify all ledger invariants and catch injected corruption
verify:
	npm run verify -- --demo-corruption

# Execute chaos test harness (T1, T4, T5, T9)
chaos:
	npm run chaos

# High concurrency load tests (storms, 5,000 roster sync)
load:
	npm run load

# Seed plan catalog with schema validation & diff
seed:
	npm run seed:plans

# Run database migrations
migrate:
	npm run migrate

# Launch multi-replica docker compose stack
docker-up:
	docker compose up --build -d

# Stop docker compose stack
docker-down:
	docker compose down -v

clean:
	rm -rf dist node_modules coverage
