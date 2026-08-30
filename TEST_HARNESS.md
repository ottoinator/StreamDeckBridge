# Docker QA

Run the complete reproducible test and plugin-build gate with:

```bash
docker compose -f compose.qa.yml build qa
docker compose -f compose.qa.yml run --rm qa
```

The suite checks bridge projections, the three-view cycle (both independent IBKR Paper lanes and Mamba Transfer What-if), legacy US/Native95/MLB selection migration, fail-closed missing Paper evidence, visible 40-session lineage progress, removal of MLB/Weather/BTC from direct selection, the five unchanged Noah metric tile keys, and the unchanged 11-action plugin contract. Legacy MLB parser tests remain isolated and inactive. The harness never calls a trading endpoint and needs no credentials.
