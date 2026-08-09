# Docker-only QA

Alle Build- und Testpruefungen laufen im isolierten Node-20-Container. Der Container hat kein Netzwerk und erhaelt keine Runtime-Secrets.

```bash
mkdir -p .qa/reports
docker compose -f compose.qa.yml build qa
docker compose -f compose.qa.yml run --rm qa sh -lc 'npm run build:plugin && npm test' \
  | tee .qa/reports/operator-tiles.log
```

Der Lauf prueft den TypeScript-/Rollup-Build, den exakt drei Actions grossen Manifestvertrag, US-only Fail-Closed-Semantik sowie MLB-/Weather-Authority- und Freshness-Zustaende.
