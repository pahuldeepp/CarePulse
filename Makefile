.PHONY: sre-up sre-down sre-status sre-tabletop sre-grafana sre-prometheus integration

COMPOSE := docker compose -f infra/docker/docker-compose.yml

sre-up:  ## Bring up the full observability stack
	$(COMPOSE) up -d postgres kafka connect prometheus grafana
	@echo
	@echo "Stack starting. Once healthy:"
	@echo "  Grafana:    http://localhost:3000  (admin/admin)"
	@echo "  Prometheus: http://localhost:9090"
	@echo "  Targets:    http://localhost:9090/targets"
	@echo
	@echo "Watch readiness:  make sre-status"

sre-down:  ## Stop the observability stack
	$(COMPOSE) down

sre-status:  ## Show health of the SRE stack
	@$(COMPOSE) ps prometheus grafana postgres kafka connect

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

help:
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

.DEFAULT_GOAL := help
