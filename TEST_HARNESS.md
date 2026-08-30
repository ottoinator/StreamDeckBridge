# Docker QA

Run the complete reproducible test and plugin-build gate with:

```bash
docker compose -f compose.qa.yml build qa
docker compose -f compose.qa.yml run --rm qa
```

The suite checks bridge projections, the five-view cycle (both independent IBKR Paper lanes, Mamba Transfer What-if, `MLB Elo V2`, `MLB Teamform`), legacy US/Native95 selection migration, fail-closed missing Paper evidence, visible 40-session lineage progress, removal of Weather/BTC from direct selection, the five unchanged Noah metric tile keys, and the unchanged 11-action plugin contract. It never calls a trading endpoint and needs no credentials.
