# Docker QA

Run the complete reproducible test and plugin-build gate with:

```bash
docker compose -f compose.qa.yml build qa
docker compose -f compose.qa.yml run --rm qa
```

The suite checks bridge projections, three-view cycling contracts, the five unchanged Noah metric tiles, and the unchanged 11-action plugin contract. It never calls a trading endpoint and needs no credentials.
