.PHONY: sre-up sre-down sre-status sre-tabletop sre-grafana sre-prometheus integration \
        chaos-up chaos-down chaos-setup chaos-reset \
        chaos-kafka-lag chaos-postgres-slow chaos-redis-down chaos-kafka-down chaos-drill

COMPOSE := docker compose -f infra/docker/docker-compose.yml

sre-up:  ## Bring up the full observability stack
	$(COMPOSE) up -d postgres kafka connect prometheus grafana blackbox
	@echo
	@echo "Stack starting. Once healthy:"
	@echo "  Grafana:    http://localhost:3000  (admin/carepack)"
	@echo "  Prometheus: http://localhost:9090"
	@echo "  Targets:    http://localhost:9090/targets"
	@echo "  Probes:     http://localhost:9090/targets#blackbox-health"
	@echo "  Blackbox:   http://localhost:9115"
	@echo
	@echo "Watch readiness:  make sre-status"

sre-down:  ## Stop the observability stack
	$(COMPOSE) down

sre-status:  ## Show health of the SRE stack
	@$(COMPOSE) ps prometheus grafana postgres kafka connect

sre-probes:  ## Open the Blackbox probe status in Prometheus
	@open http://localhost:9090/targets#blackbox-health 2>/dev/null \
	  || xdg-open http://localhost:9090/targets#blackbox-health 2>/dev/null \
	  || echo "Open manually: http://localhost:9090/targets#blackbox-health"

sre-uptime:  ## Open the Grafana uptime dashboard
	@open http://localhost:3000/d/carepulse-uptime 2>/dev/null \
	  || xdg-open http://localhost:3000/d/carepulse-uptime 2>/dev/null \
	  || echo "Open manually: http://localhost:3000/d/carepulse-uptime"

sre-grafana:  ## Open the SLO dashboard in your browser
	@open http://localhost:3000/d/carepulse-slo 2>/dev/null \
	  || xdg-open http://localhost:3000/d/carepulse-slo 2>/dev/null \
	  || echo "Open manually: http://localhost:3000/d/carepulse-slo"

sre-prometheus:  ## Open Prometheus targets page
	@open http://localhost:9090/targets 2>/dev/null \
	  || xdg-open http://localhost:9090/targets 2>/dev/null \
	  || echo "Open manually: http://localhost:9090/targets"

sre-tabletop:  ## Run the burn-rate tabletop test against gateway-graphql
	./scripts/sre/tabletop-burn-rate.sh

integration:  ## Run the S9-08 end-to-end alert-flow assertion
	./scripts/integration/s9-08-alert-flow.sh

# ── S10 Chaos targets ─────────────────────────────────────────────────────────

chaos-up:  ## Start Toxiproxy + observability stack
	$(COMPOSE) up -d postgres kafka redis connect prometheus grafana toxiproxy
	@echo "Toxiproxy REST API: http://localhost:8474"
	@echo "Run: make chaos-setup  to register proxies"

chaos-down:  ## Stop Toxiproxy (keeps rest of stack running)
	$(COMPOSE) stop toxiproxy

chaos-setup:  ## Register Kafka / Postgres / Redis proxies in Toxiproxy
	./scripts/sre/chaos-setup.sh

chaos-reset:  ## Remove all active toxics (restore normal operation)
	./scripts/sre/chaos-reset.sh

chaos-kafka-lag:  ## Inject 500 ms Kafka latency (stresses alert-pipeline SLO)
	@python3 -c "import json; d=json.load(open('chaos/kafka-lag.json')); print(json.dumps(d['toxic']))" | \
	  curl -sf -X POST http://localhost:8474/proxies/kafka/toxics -H 'Content-Type: application/json' -d @- > /dev/null
	@echo "Injected: kafka-lag (500 ms latency). Remove with: make chaos-reset"

chaos-postgres-slow:  ## Inject 200 ms Postgres latency (stresses write SLO)
	@python3 -c "import json; d=json.load(open('chaos/postgres-slow.json')); print(json.dumps(d['toxic']))" | \
	  curl -sf -X POST http://localhost:8474/proxies/postgres/toxics -H 'Content-Type: application/json' -d @- > /dev/null
	@echo "Injected: postgres-slow (200 ms latency). Remove with: make chaos-reset"

chaos-redis-down:  ## Kill Redis bandwidth (validates alert resilience path)
	@python3 -c "import json; d=json.load(open('chaos/redis-down.json')); print(json.dumps(d['toxic']))" | \
	  curl -sf -X POST http://localhost:8474/proxies/redis/toxics -H 'Content-Type: application/json' -d @- > /dev/null
	@echo "Injected: redis-down (zero bandwidth). Remove with: make chaos-reset"

chaos-kafka-down:  ## Reset all Kafka connections (DLQ fallback drill)
	@python3 -c "import json; d=json.load(open('chaos/kafka-down.json')); print(json.dumps(d['toxic']))" | \
	  curl -sf -X POST http://localhost:8474/proxies/kafka/toxics -H 'Content-Type: application/json' -d @- > /dev/null
	@echo "Injected: kafka-down (connection reset). Remove with: make chaos-reset"

chaos-drill:  ## Run all scenarios in sequence with Prometheus assertions
	./scripts/sre/chaos-drill.sh all

help:
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

.DEFAULT_GOAL := help
