import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildOperatorTiles } from "../bridge/monitor-bridge.mjs";

const NOW = Date.parse("2026-08-09T15:10:00.000Z");

function validSources(overrides = {}) {
  return {
    usRuntime: {
      status: "online",
      market: "us",
      market_registry: { canonical_market_key: "us" },
      market_session: {
        market_open: false,
        market_session_status: "closed",
        runtime_mode: "IDLE",
        trade_day: "2026-08-07"
      }
    },
    mlbContinuity: {
      status: "ok",
      operator_state: "running",
      observed_at_utc: "2026-08-09T15:09:00.000Z",
      paper_only: true,
      live_trading_authority: false,
      order_authority: "none"
    },
    mlbCapture: {
      observed_at_utc: "2026-08-09T15:08:00.000Z",
      capture_count: 3,
      circuit_open: false,
      paper_only: true,
      live_trading_authority: false,
      order_authority: "none"
    },
    mlbPaper: {
      observed_at_utc: "2026-08-09T15:09:30.000Z",
      epoch_status: "active",
      settled_count: 1,
      ledger_integrity: "pass",
      paper_only: true,
      live_trading_authority: false,
      order_authority: "none"
    },
    weatherStatus: {
      status: "running",
      reason: "public_sources_current",
      observed_at_utc: "2026-08-09T15:05:00.000Z",
      paper_only: true,
      api_cost_usd: "0.00"
    },
    ...overrides
  };
}

test("operator state contains exactly US runtime, MLB Elo v2, and public Weather", () => {
  const tiles = buildOperatorTiles(validSources(), NOW);

  assert.deepEqual(tiles.map(tile => tile.key), ["us_runtime", "mlb_elo_v2", "weather_public"]);
  assert.equal(tiles[0].line1, "CLOSED");
  assert.equal(tiles[1].line1, "RUNNING");
  assert.equal(tiles[1].line2, "C 3 · S 1");
  assert.equal(tiles[2].status, "ok");
  assert.equal(tiles[2].footer, "AWC + NWS");
});

test("US runtime fails closed when the Companion payload is not canonical US", () => {
  const tiles = buildOperatorTiles(validSources({
    usRuntime: {
      status: "online",
      market: "crypto",
      market_registry: { canonical_market_key: "crypto" },
      market_session: { market_open: true, market_session_status: "open" }
    }
  }), NOW);

  const tile = tiles.find(item => item.key === "us_runtime");
  assert.equal(tile.status, "error");
  assert.equal(tile.line1, "BLOCKED");
  assert.equal(tile.line2, "Nicht US");
});

test("MLB and Weather authority or freshness failures are visible and never green", () => {
  const tiles = buildOperatorTiles(validSources({
    mlbPaper: {
      ...validSources().mlbPaper,
      order_authority: "live"
    },
    weatherStatus: {
      status: "blocked",
      reason: "command_failed:docker:image",
      observed_at_utc: "2026-08-09T15:02:30.000Z",
      paper_only: true,
      api_cost_usd: "0.00"
    }
  }), NOW);

  const mlb = tiles.find(item => item.key === "mlb_elo_v2");
  const weather = tiles.find(item => item.key === "weather_public");
  assert.equal(mlb.status, "error");
  assert.equal(mlb.line1, "BLOCKED");
  assert.equal(weather.status, "error");
  assert.equal(weather.line1, "BLOCKED");
  assert.equal(weather.line2, "Docker Image");
});

test("plugin manifest and registrations expose exactly the three operator actions", async () => {
  const manifest = JSON.parse(await readFile(
    new URL("../streamdeck-plugin/com.codex.stream-monitor.sdPlugin/manifest.json", import.meta.url),
    "utf8"
  ));
  const pluginSource = await readFile(new URL("../streamdeck-plugin/src/plugin.ts", import.meta.url), "utf8");

  assert.deepEqual(manifest.Actions.map(action => action.Name), ["US Runtime", "MLB Elo v2", "Weather Public"]);
  assert.deepEqual(manifest.Actions.map(action => action.UUID), [
    "com.codex.stream-monitor.noah.cycle",
    "com.codex.stream-monitor.noah.weekly-pnl",
    "com.codex.stream-monitor.noah.daily-pnl"
  ]);
  assert.equal((pluginSource.match(/registerAction\(/g) || []).length, 3);
  for (const forbidden of ["Slot1Action", "CarmenLightAction", "NoahLiveMarketsAction", "NoahTradesTodayAction"]) {
    assert.equal(pluginSource.includes(forbidden), false, forbidden);
  }
});
