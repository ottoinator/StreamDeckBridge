import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  buildMlbEloV2Summary,
  buildMambaWhatIfSummary,
  buildNoahTiles,
  buildWeatherPublicSummary,
  normalizeNoahViewMarket
} from "../bridge/monitor-bridge.mjs";

const NOW = Date.parse("2026-08-09T18:30:00Z");
const authority = { paper_only: true, live_trading_authority: false, order_authority: "none" };

test("view aliases migrate legacy selections and expose both Mamba challengers", () => {
  assert.deepEqual(
    ["us", "us_runtime", "default_lane", "combined", "crypto", "prediction_markets"].map(normalizeNoahViewMarket),
    ["us", "us", "us", "us", "us", "us"]
  );
  assert.equal(normalizeNoahViewMarket("mlb_elo_v2"), "mlb_elo_v2");
  assert.equal(normalizeNoahViewMarket("weather"), "weather_public");
  assert.equal(normalizeNoahViewMarket("mamba_transfer"), "mamba_transfer_52_95");
  assert.equal(normalizeNoahViewMarket("native95"), "mamba_native95");
  assert.throws(() => normalizeNoahViewMarket("eu"));
});

test("Mamba transfer tile view keeps raw and normalized PnL visibly what-if", () => {
  const summary = buildMambaWhatIfSummary({
    generated_at_utc: "2026-08-21T20:00:00Z",
    mamba_challengers: {
      transfer52_to_95: {
        label: "Mamba Transfer 52→95",
        model_variant: "fixed52_transfer_to_95",
        status: "finalized",
        pnl_kind: "what_if",
        comparison_status: "comparable",
        raw: {
          day: { available: true, pnl_eur: 303.16, trade_count: 1 },
          week: { available: true, pnl_eur: 892.597, trade_count: 3 },
          cumulative: { available: true, pnl_eur: 1043.3, trade_count: 4 }
        },
        normalized: {
          day: { available: true, pnl_eur: 12.34, trade_count: 1 },
          week: { available: true, pnl_eur: 45.67, trade_count: 3 },
          cumulative: { available: true, pnl_eur: 50.12, trade_count: 4 }
        }
      }
    }
  }, "mamba_transfer_52_95");
  const tiles = buildNoahTiles(summary);
  assert.equal(summary.selected_market, "mamba_transfer_52_95");
  assert.equal(tiles.find(tile => tile.key === "daily_pnl").line1, "+303,16 EUR");
  assert.equal(tiles.find(tile => tile.key === "daily_pnl").line2, "NORM +12,34 EUR");
  assert.equal(tiles.find(tile => tile.key === "daily_pnl").footer, "WHAT-IF");
  assert.equal(tiles.find(tile => tile.key === "weekly_pnl").footer, "WHAT-IF");
  assert.equal(tiles.find(tile => tile.key === "trades_today").line1, "Open n/a");
  assert.equal(tiles.find(tile => tile.key === "trades_today").line2, "Close 1");
  assert.equal(tiles.find(tile => tile.key === "live_markets").line1, "MAMBA 52>95");
  assert.equal(tiles.find(tile => tile.key === "live_markets").line2, "WHAT-IF");
});

test("Mamba Native95 fails closed to n/a instead of inventing zero PnL", () => {
  const summary = buildMambaWhatIfSummary({
    mamba_challengers: {
      native95: {
        label: "Mamba Native95",
        model_variant: "native95",
        status: "collecting",
        pnl_kind: "what_if",
        comparison_status: "unavailable",
        reason: "normalization_pending",
        raw: {
          day: { available: false, reason: "day_not_finalized" },
          week: { available: false, reason: "no_finalized_days" },
          cumulative: { available: false, reason: "no_finalized_days" }
        },
        normalized: {
          day: { available: false, reason: "comparator_pending" },
          week: { available: false, reason: "comparator_pending" },
          cumulative: { available: false, reason: "comparator_pending" }
        }
      }
    }
  }, "mamba_native95");
  const tiles = buildNoahTiles(summary);
  assert.equal(tiles.find(tile => tile.key === "daily_pnl").line1, "n/a");
  assert.equal(tiles.find(tile => tile.key === "daily_pnl").line2, "NORM n/a");
  assert.equal(tiles.find(tile => tile.key === "weekly_pnl").line1, "n/a");
  assert.equal(tiles.find(tile => tile.key === "trades_today").line2, "Close n/a");
  assert.equal(tiles.find(tile => tile.key === "daily_pnl").status, "warn");
  assert.equal(tiles.find(tile => tile.key === "live_markets").line1, "MAMBA N95");
});

test("Mamba observer parser rejects booked or unknown PnL kinds", () => {
  const summary = buildMambaWhatIfSummary({
    mamba_challengers: {
      native95: { pnl_kind: "booked" }
    }
  }, "mamba_native95");
  assert.match(summary.error, /PnL-Kind blockiert/);
});

test("bridge no longer reads a Companion token from SSH or systemd", async () => {
  const bridgeSource = await readFile(new URL("../bridge/monitor-bridge.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(bridgeSource, /systemctl['"],\s*['"]cat/);
  assert.doesNotMatch(bridgeSource, /NOAH_COMPANION_API_TOKEN/);
});

test("MLB Elo v2 feeds all five legacy Noah tiles without changing their keys", () => {
  const summary = buildMlbEloV2Summary({
    continuity: { ...authority, observed_at_utc: "2026-08-09T18:29:30Z", status: "ok", operator_state: "running" },
    capture: { ...authority, observed_at_utc: "2026-08-09T18:29:20Z", circuit_open: false, next_wake_at_utc: "2026-08-09T18:31:00Z" },
    paper: { ...authority, research_only: true, observed_at_utc: "2026-08-09T18:29:25Z", epoch_status: "active", ledger_integrity: "pass", open_position_count: 5, settled_count: 0, starting_nav_eur: 100 }
  }, NOW);
  const tiles = buildNoahTiles(summary);
  assert.deepEqual(tiles.map(tile => tile.key), ["cycle", "weekly_pnl", "daily_pnl", "trades_today", "live_markets"]);
  assert.equal(tiles.find(tile => tile.key === "trades_today").line1, "Open 5");
  assert.equal(tiles.find(tile => tile.key === "weekly_pnl").line1, "0,00 EUR");
  assert.equal(tiles.find(tile => tile.key === "live_markets").line1, "MLB V2");
  assert.equal(tiles.find(tile => tile.key === "live_markets").line2, "RUNNING");
});

test("Weather public keeps metrics visible but reports a blocked public monitor", () => {
  const summary = buildWeatherPublicSummary({
    monitor: { paper_only: true, observed_at_utc: "2026-08-09T18:03:00Z", status: "blocked", reason: "command_failed:docker:image" },
    cadence: { ...authority, wallet_authority: "none", scheduler_authority: "none", status: "cycle_running", last_cycle_completed_at_utc: "2026-08-09T18:29:00Z", next_capture_not_before_utc: "2026-08-09T18:31:00Z" },
    evidence: { ...authority, wallet_authority: "none", observed_at_utc: "2026-08-09T18:29:10Z", open_position_count: 4, settled_position_count: 0, realized_terminal_pnl_usd: "0.00" }
  }, NOW);
  const tiles = buildNoahTiles(summary);
  assert.equal(tiles.length, 5);
  assert.equal(tiles.find(tile => tile.key === "live_markets").status, "error");
  assert.equal(tiles.find(tile => tile.key === "live_markets").line1, "WEATHER");
  assert.equal(tiles.find(tile => tile.key === "live_markets").line2, "BLOCKED");
  assert.notEqual(tiles.find(tile => tile.key === "cycle").status, "ok");
  assert.equal(tiles.find(tile => tile.key === "daily_pnl").line1, "0,00 USD");
  assert.equal(tiles.find(tile => tile.key === "trades_today").line1, "Open 4");
});

test("Weather public reports the permanent Exact-8 daemon without legacy artifacts", () => {
  const summary = buildWeatherPublicSummary({
    monitor: {
      kind: "paper_exact8_daemon_status_v1",
      paper_only: true,
      heartbeat_at_utc: "2026-08-09T18:29:45Z",
      phase: "waiting",
      ready: true,
      running: true,
      degraded: false,
      aggregate_paper_settled: 3,
      open_paper_positions: 2,
      net_pnl_cents: 37,
      next_action_at_utc: "2026-08-10T14:30:00Z",
      authorities: { order: "none", wallet: "none", promotion: "none", scheduler: "paper_daily_only" }
    },
    cadence: null,
    evidence: null
  }, NOW);
  const tiles = buildNoahTiles(summary);
  assert.equal(summary.view_status, "ok");
  assert.equal(summary.view_status_label, "WAITING");
  assert.equal(summary.cycle.next_cycle_at, "2026-08-10T14:30:00Z");
  assert.equal(tiles.find(tile => tile.key === "trades_today").line1, "Open 2");
  assert.equal(tiles.find(tile => tile.key === "trades_today").line2, "Close 3");
  assert.equal(summary.pnl.daily_eur, 0.37);
  assert.equal(tiles.find(tile => tile.key === "live_markets").line2, "WAITING");
});

test("Weather public defaults to the isolated Edge v2 controller status", async () => {
  const bridgeSource = await readFile(new URL("../bridge/monitor-bridge.mjs", import.meta.url), "utf8");
  assert.match(bridgeSource, /NoahData\/paper-edge-v2\/control\/control\/status\.json/);
  assert.doesNotMatch(bridgeSource, /NoahData\/paper-lane-daemon\/control\/control\/status\.json/);
});

test("Weather public rejects authority drift in the Exact-8 daemon", () => {
  const summary = buildWeatherPublicSummary({
    monitor: {
      kind: "paper_exact8_daemon_status_v1",
      paper_only: true,
      heartbeat_at_utc: "2026-08-09T18:29:45Z",
      phase: "waiting",
      ready: true,
      running: true,
      degraded: false,
      authorities: { order: "none", wallet: "none", promotion: "none", scheduler: "unbounded" }
    },
    cadence: null,
    evidence: null
  }, NOW);
  assert.equal(summary.error, "Weather Public Authority blockiert");
});

test("plugin contract still contains and registers all eleven original actions", async () => {
  const manifest = JSON.parse(await readFile(new URL("../streamdeck-plugin/com.codex.stream-monitor.sdPlugin/manifest.json", import.meta.url), "utf8"));
  const pluginSource = await readFile(new URL("../streamdeck-plugin/src/plugin.ts", import.meta.url), "utf8");
  assert.equal(manifest.Actions.length, 11);
  assert.equal(new Set(manifest.Actions.map(action => action.UUID)).size, 11);
  for (const uuid of [
    "com.codex.stream-monitor.slot1",
    "com.codex.stream-monitor.slot2",
    "com.codex.stream-monitor.slot3",
    "com.codex.stream-monitor.slot4",
    "com.codex.stream-monitor.agent.noah",
    "com.codex.stream-monitor.agent.carmen",
    "com.codex.stream-monitor.noah.cycle",
    "com.codex.stream-monitor.noah.weekly-pnl",
    "com.codex.stream-monitor.noah.daily-pnl",
    "com.codex.stream-monitor.noah.trades-today",
    "com.codex.stream-monitor.noah.live-markets"
  ]) {
    assert.ok(manifest.Actions.some(action => action.UUID === uuid), uuid);
  }
  assert.equal((pluginSource.match(/registerAction\(/g) || []).length, 11);
  for (const [file, className, uuid] of [
    ["slot-1.ts", "Slot1Action", "com.codex.stream-monitor.slot1"],
    ["slot-2.ts", "Slot2Action", "com.codex.stream-monitor.slot2"],
    ["slot-3.ts", "Slot3Action", "com.codex.stream-monitor.slot3"],
    ["slot-4.ts", "Slot4Action", "com.codex.stream-monitor.slot4"],
    ["noah-light.ts", "NoahLightAction", "com.codex.stream-monitor.agent.noah"],
    ["carmen-light.ts", "CarmenLightAction", "com.codex.stream-monitor.agent.carmen"],
    ["noah-cycle.ts", "NoahCycleAction", "com.codex.stream-monitor.noah.cycle"],
    ["noah-weekly-pnl.ts", "NoahWeeklyPnlAction", "com.codex.stream-monitor.noah.weekly-pnl"],
    ["noah-daily-pnl.ts", "NoahDailyPnlAction", "com.codex.stream-monitor.noah.daily-pnl"],
    ["noah-trades-today.ts", "NoahTradesTodayAction", "com.codex.stream-monitor.noah.trades-today"],
    ["noah-live-markets.ts", "NoahLiveMarketsAction", "com.codex.stream-monitor.noah.live-markets"]
  ]) {
    const actionSource = await readFile(new URL(`../streamdeck-plugin/src/actions/${file}`, import.meta.url), "utf8");
    assert.match(actionSource, new RegExp(`UUID:\\s*["']${uuid.replaceAll(".", "\\.")}["']`));
    assert.match(pluginSource, new RegExp(`import \\{ ${className} \\}`));
    assert.match(pluginSource, new RegExp(`registerAction\\(new ${className}\\(\\)\\)`));
  }
  const publicViewText = JSON.stringify(buildNoahTiles(buildWeatherPublicSummary({
    monitor: { paper_only: true, observed_at_utc: "2026-08-09T18:03:00Z", status: "blocked" },
    cadence: { ...authority, wallet_authority: "none", scheduler_authority: "none", status: "cycle_running", last_cycle_completed_at_utc: "2026-08-09T18:29:00Z" },
    evidence: { ...authority, wallet_authority: "none", observed_at_utc: "2026-08-09T18:29:10Z", open_position_count: 0, settled_position_count: 0 }
  }, NOW))).toLowerCase();
  for (const forbidden of ["crypto", "prediction", "combined", "xetra", "japan"]) {
    assert.equal(publicViewText.includes(forbidden), false, forbidden);
  }
});
