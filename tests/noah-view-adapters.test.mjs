import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  buildBrokerPaperLaneSummary,
  buildMlbEloV2Summary,
  buildMlbTeamFormV3Summary,
  buildMambaWhatIfSummary,
  buildPaperLaneSummary,
  buildNoahSummaryFromStreamdeckTiles,
  buildNoahTiles,
  normalizeNoahViewMarket
} from "../bridge/monitor-bridge.mjs";

const NOW = Date.parse("2026-08-09T18:30:00Z");
const authority = { paper_only: true, live_trading_authority: false, order_authority: "none" };

function promotionLane(laneId, role, label, pnl, available, allDays, brokerDays) {
  const track = count => ({ valid_day_count: count, target_valid_sessions: 40, remaining_valid_sessions: 40 - count });
  return {
    strategy_lineage_id: role === "primary" ? "native95_fixed60" : "orb13",
    lane_id: laneId,
    label,
    current_role: role,
    paper_only: true,
    pnl_basis: "actual_broker_paper",
    current_day: {
      trade_day: "2026-08-28", state: available ? "booked" : "pending", available,
      actual_pnl_eur: available ? pnl : null, trade_count: available ? 1 : null, receipt_id: available ? "a".repeat(64) : null
    },
    promotion_progress: { state: available ? "collecting" : "blocked", promotion_allowed: false, blockers: [available ? "40_valid_sessions_not_complete" : "commission_pending"] },
    tracks: {
      all_valid_paper_strategy_track: track(allDays),
      broker_actual_track: track(brokerDays),
      legacy_nonbroker_track: track(allDays - brokerDays)
    },
    source_audit: { status: available ? "complete" : "pending" }
  };
}

function promotionEvidence(lanes) {
  return {
    contract_version: "noah.us.lane-promotion-evidence.v2", available: true, state: "available",
    paper_only: true, target_valid_sessions: 40, fallback_used: false, lanes
  };
}

test("view aliases migrate legacy Native95 selections to the booked primary lane", () => {
  assert.deepEqual(
    ["us", "us_runtime", "default_lane", "combined", "crypto", "prediction_markets"].map(normalizeNoahViewMarket),
    ["paper_primary", "paper_primary", "paper_primary", "paper_primary", "paper_primary", "paper_primary"]
  );
  assert.equal(normalizeNoahViewMarket("mlb_elo_v2"), "paper_primary");
  assert.equal(normalizeNoahViewMarket("weather"), "paper_primary");
  assert.equal(normalizeNoahViewMarket("btc"), "paper_primary");
  assert.equal(normalizeNoahViewMarket("teamform"), "paper_primary");
  assert.equal(normalizeNoahViewMarket("mamba_transfer"), "mamba_transfer_52_95");
  assert.equal(normalizeNoahViewMarket("native95"), "paper_primary");
  assert.equal(normalizeNoahViewMarket("mamba_native95"), "paper_primary");
  assert.equal(normalizeNoahViewMarket("orb13"), "paper_challenger");
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

test("Native95 primary renders booked IBKR Paper PnL without BPS or lane summing", () => {
  const summary = buildPaperLaneSummary({
    generated_at_utc: "2026-08-28T21:00:00Z",
    lane_promotion_evidence: promotionEvidence([
      promotionLane("noah_us_native95_fixed60_ibkr_paper_v2", "primary", "Native95 · Fixed60", 18.25, true, 15, 2),
      promotionLane("noah_us_orb13_ibkr_paper_v2", "paper_challenger", "ORB13", 999, true, 9, 3)
    ])
  }, "paper_primary");
  const tiles = buildNoahTiles(summary);
  assert.equal(summary.lane.role, "primary");
  assert.equal(summary.pnl.daily_eur, 18.25);
  assert.equal(Number.isNaN(summary.pnl.weekly_eur), true);
  assert.equal(tiles.find(tile => tile.key === "daily_pnl").line1, "+18,25 EUR");
  assert.equal(tiles.find(tile => tile.key === "weekly_pnl").line1, "n/a");
  assert.equal(tiles.find(tile => tile.key === "weekly_pnl").line2, "15/40 · COLLECTING");
  assert.equal(tiles.find(tile => tile.key === "cycle").line2, "COLLECTING · 2/40");
  assert.equal(tiles.find(tile => tile.key === "daily_pnl").footer, "ECHTER PAPER-PNL");
  assert.doesNotMatch(JSON.stringify(tiles), /BPS|WHAT-IF|999/);
});

test("ORB13 challenger is independent and pending evidence fails closed to n/a", () => {
  const observer = {
    lane_promotion_evidence: promotionEvidence([
      promotionLane("noah_us_native95_fixed60_ibkr_paper_v2", "primary", "Native95 · Fixed60", 3, true, 15, 2),
      promotionLane("noah_us_orb13_ibkr_paper_v2", "paper_challenger", "ORB13", null, false, 9, 2)
    ])
  };
  const summary = buildPaperLaneSummary(observer, "paper_challenger");
  const tiles = buildNoahTiles(summary);
  assert.equal(summary.lane.role, "paper_challenger");
  assert.equal(tiles.find(tile => tile.key === "daily_pnl").line1, "n/a");
  assert.equal(tiles.find(tile => tile.key === "weekly_pnl").line1, "n/a");
  assert.equal(tiles.find(tile => tile.key === "trades_today").line2, "Close n/a");
  assert.equal(tiles.find(tile => tile.key === "daily_pnl").status, "warn");
  assert.equal(tiles.find(tile => tile.key === "weekly_pnl").line2, "9/40 · BLOCKED");
  assert.equal(tiles.find(tile => tile.key === "cycle").line2, "BLOCKED · 2/40");
  assert.doesNotMatch(JSON.stringify(tiles), /BPS|WHAT-IF/);
});

test("Paper lane parser blocks unsafe authority and never falls back to What-if", () => {
  const unsafe = buildPaperLaneSummary({
    paper_lane_contract: { contract_version: "noah.us.ibkr-paper-lanes.v2", independent_books: true, combined_pnl_claim: false },
    paper_lanes: [{ role: "primary", paper_only: true, what_if_only: true, execution_source: "ibkr_paper", live_trading_authority: false }],
    mamba_challengers: { native95: { pnl_kind: "what_if", raw: { day: { available: true, pnl_eur: 123 } } } }
  }, "paper_primary");
  assert.match(unsafe.error, /Authority blockiert/);

  const promotion = promotionEvidence([
    promotionLane("noah_us_native95_fixed60_ibkr_paper_v2", "primary", "Native95", 5, true, 15, 2),
    promotionLane("noah_us_orb13_ibkr_paper_v2", "paper_challenger", "ORB13", 1, true, 9, 2)
  ]);
  promotion.lanes[0].promotion_progress.promotion_allowed = true;
  const ownerGate = buildPaperLaneSummary({ lane_promotion_evidence: promotion }, "paper_primary");
  assert.equal(ownerGate.view_status, "error");
  assert.equal(ownerGate.lane.promotion_allowed, false);
});

test("Native95 Stream Deck view uses broker fills and pending accounting truth", () => {
  const summary = buildBrokerPaperLaneSummary({
    contract_version: "streamdeck_tiles_v1",
    generated_at_utc: "2026-08-31T14:33:00Z",
    paper_lanes: {
      contract: "noah_us_ibkr_paper_lanes_operator_projection_v1",
      generated_at_utc: "2026-08-31T14:33:00Z",
      lanes: [{
        key: "native95",
        lane_id: "noah_us_native95_fixed60_ibkr_paper_v2",
        paper_only: true,
        freshness: { status: "fresh" },
        accounting: { status: "pending_commission", booked_pnl_eur: null },
        outcome_counts: { filled: 1, pending: 1, rejected: 0 },
        trades: [{ execution_status: "exit_filled", accounting_status: "pending_commission", symbol: "AMD" }]
      }]
    }
  });
  const tiles = buildNoahTiles(summary);
  assert.equal(summary.pnl.kind, "broker_paper");
  assert.equal(tiles.find(tile => tile.key === "cycle").line2, "EXIT FILLED");
  assert.equal(tiles.find(tile => tile.key === "daily_pnl").line1, "n/a");
  assert.equal(tiles.find(tile => tile.key === "daily_pnl").line2, "PENDING COMMISSION");
  assert.equal(tiles.find(tile => tile.key === "trades_today").line1, "Fill 1");
  assert.equal(tiles.find(tile => tile.key === "trades_today").line2, "Pending 1");
  assert.equal(tiles.find(tile => tile.key === "daily_pnl").status, "warn");
  assert.equal(tiles.find(tile => tile.key === "live_markets").line2, "EXIT FILLED");
});

test("default Noah tiles surface ORB broker rejections after the market closes", () => {
  const summary = buildNoahSummaryFromStreamdeckTiles({
    contract_version: "streamdeck_tiles_v1",
    generated_at_utc: "2026-08-31T20:05:00Z",
    market: "us",
    cycle: { trading: false },
    pnl: { daily_eur: 0, daily_pct: 0, weekly_eur: 0, weekly_pct: 0, paper_daily_eur: null, paper_status: "pending" },
    trades_today: { open: 0, closed: 0, paper_filled: 1, paper_pending: 1, paper_rejected: 4 },
    live: { configured_markets: ["US"], trading_markets: [], configured_products: ["EQ"], trading_products: [] },
    markets: {},
    paper_lanes: { contract: "noah_us_ibkr_paper_lanes_operator_projection_v1", lanes: [] }
  });
  const tradeTile = buildNoahTiles(summary).find(tile => tile.key === "trades_today");
  assert.equal(tradeTile.line1, "Fill 1");
  assert.equal(tradeTile.line2, "Reject 4");
  assert.equal(tradeTile.status, "error");
});

test("ORB13 view shows broker rejections without fabricated PnL", () => {
  const summary = buildBrokerPaperLaneSummary({
    contract_version: "streamdeck_tiles_v1",
    generated_at_utc: "2026-08-31T14:33:00Z",
    paper_lanes: {
      contract: "noah_us_ibkr_paper_lanes_operator_projection_v1",
      generated_at_utc: "2026-08-31T14:33:00Z",
      lanes: [{
        key: "orb13",
        lane_id: "noah_us_orb13_ibkr_paper_v2",
        paper_only: true,
        freshness: { status: "fresh" },
        accounting: { status: "no_trades", booked_pnl_eur: null },
        outcome_counts: { filled: 0, pending: 0, rejected: 4 },
        trades: [{ execution_status: "broker_rejected", accounting_status: "rejected", symbol: "CRWD" }]
      }]
    }
  }, "paper_challenger");
  const tiles = buildNoahTiles(summary);
  assert.equal(summary.selected_market, "paper_challenger");
  assert.equal(tiles.find(tile => tile.key === "daily_pnl").line1, "n/a");
  assert.equal(tiles.find(tile => tile.key === "trades_today").line1, "Fill 0");
  assert.equal(tiles.find(tile => tile.key === "trades_today").line2, "Reject 4");
  assert.equal(tiles.find(tile => tile.key === "trades_today").status, "error");
});

test("ORB13 fresh no-trades outcome is a valid terminal Stream Deck state", () => {
  const summary = buildBrokerPaperLaneSummary({
    contract_version: "streamdeck_tiles_v1",
    generated_at_utc: "2026-09-04T14:42:36Z",
    paper_lanes: {
      contract: "noah_us_ibkr_paper_lanes_operator_projection_v1",
      generated_at_utc: "2026-09-04T14:42:36Z",
      lanes: [{
        key: "orb13",
        lane_id: "noah_us_orb13_ibkr_paper_v2",
        paper_only: true,
        freshness: { status: "fresh" },
        accounting: { status: "no_trades", booked_pnl_eur: null },
        outcome_counts: { attempted: 0, booked: 0, filled: 0, no_fill: 0, pending: 0, rejected: 0 },
        trades: []
      }]
    }
  }, "paper_challenger");
  const tiles = buildNoahTiles(summary);
  assert.equal(summary.selected_market, "paper_challenger");
  assert.equal(summary.lane.execution_status, "no_trades");
  assert.equal(summary.view_status, "ok");
  assert.deepEqual(summary.warnings, {});
  assert.equal(tiles.find(tile => tile.key === "cycle").line2, "NO TRADES");
  assert.equal(tiles.find(tile => tile.key === "cycle").status, "ok");
  assert.equal(tiles.find(tile => tile.key === "daily_pnl").line1, "n/a");
  assert.equal(tiles.find(tile => tile.key === "daily_pnl").line2, "NO TRADES");
  assert.equal(tiles.find(tile => tile.key === "daily_pnl").status, "ok");
  assert.equal(tiles.find(tile => tile.key === "trades_today").line1, "NO TRADES");
  assert.equal(tiles.find(tile => tile.key === "trades_today").status, "ok");
  assert.equal(tiles.find(tile => tile.key === "live_markets").line2, "NO TRADES");
  assert.equal(tiles.find(tile => tile.key === "live_markets").status, "ok");
});

test("ORB13 empty trades without explicit no-trades accounting remains unavailable", () => {
  const summary = buildBrokerPaperLaneSummary({
    contract_version: "streamdeck_tiles_v1",
    paper_lanes: {
      contract: "noah_us_ibkr_paper_lanes_operator_projection_v1",
      lanes: [{
        key: "orb13",
        lane_id: "noah_us_orb13_ibkr_paper_v2",
        paper_only: true,
        freshness: { status: "fresh" },
        accounting: { status: "unavailable", booked_pnl_eur: null },
        outcome_counts: { filled: 0, pending: 0, rejected: 0 },
        trades: []
      }]
    }
  }, "paper_challenger");
  assert.equal(summary.lane.execution_status, "unavailable");
  assert.equal(summary.view_status, "warn");
  assert.match(summary.warnings.accounting, /unavailable/);
});

test("ORB13 malformed or nonzero no-trades evidence fails closed", () => {
  const baseLane = {
    key: "orb13",
    lane_id: "noah_us_orb13_ibkr_paper_v2",
    paper_only: true,
    freshness: { status: "fresh" },
    accounting: { status: "no_trades", booked_pnl_eur: null },
    outcome_counts: { attempted: 0, booked: 0, filled: 0, no_fill: 0, pending: 0, rejected: 0 },
    trades: []
  };
  const invalidLanes = [
    { ...baseLane, outcome_counts: { ...baseLane.outcome_counts, attempted: 1 } },
    { ...baseLane, outcome_counts: { ...baseLane.outcome_counts, booked: 1 } },
    { ...baseLane, outcome_counts: { ...baseLane.outcome_counts, no_fill: 1 } },
    { ...baseLane, outcome_counts: { ...baseLane.outcome_counts, attempted: null } },
    { ...baseLane, outcome_counts: { ...baseLane.outcome_counts, booked: "0" } },
    { ...baseLane, outcome_counts: { ...baseLane.outcome_counts, no_fill: false } },
    { ...baseLane, freshness: { status: "stale" } },
    { ...baseLane, trades: {} },
    { ...baseLane, outcome_counts: null }
  ];
  for (const lane of invalidLanes) {
    const summary = buildBrokerPaperLaneSummary({
      contract_version: "streamdeck_tiles_v1",
      paper_lanes: {
        contract: "noah_us_ibkr_paper_lanes_operator_projection_v1",
        lanes: [lane]
      }
    }, "paper_challenger");
    assert.equal(summary.lane.execution_status, "unavailable");
    assert.equal(summary.view_status, "warn");
    assert.ok(summary.warnings.accounting || summary.warnings.freshness);
  }
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

test("MLB Teamform v3 feeds the existing tiles from its own paper-only status", () => {
  const summary = buildMlbTeamFormV3Summary({
    record_type: "mlb_nextgen_team_form_paper_status_v2",
    observed_at_utc: "2026-08-09T18:29:45Z",
    paper_only: true,
    shadow_only: true,
    live_trading_authority: false,
    order_authority: "none",
    wallet_authority: "none",
    promotion_authority: "none",
    official_booked_pnl_cents: 0,
    ledger_integrity: "pass",
    team_form_cache: { status: "healthy" },
    settlement_freshness: { status: "healthy", open_final_eligible_count: 2 },
    settlement_count: 7,
    settled_paper_pnl_cents: -3356
  }, NOW);
  const tiles = buildNoahTiles(summary);
  assert.deepEqual(tiles.map(tile => tile.key), ["cycle", "weekly_pnl", "daily_pnl", "trades_today", "live_markets"]);
  assert.equal(tiles.find(tile => tile.key === "live_markets").line1, "MLB FORM");
  assert.equal(tiles.find(tile => tile.key === "live_markets").line2, "PAPER");
  assert.equal(tiles.find(tile => tile.key === "weekly_pnl").label, "Paper PnL");
  assert.equal(tiles.find(tile => tile.key === "weekly_pnl").line1, "-33,56 EUR");
  assert.equal(tiles.find(tile => tile.key === "weekly_pnl").line2, "7 SETTLED");
  assert.equal(tiles.find(tile => tile.key === "daily_pnl").line1, "n/a");
  assert.equal(tiles.find(tile => tile.key === "daily_pnl").line2, "KEIN FENSTER");
  assert.equal(tiles.find(tile => tile.key === "trades_today").label, "Paper Trades");
  assert.equal(tiles.find(tile => tile.key === "trades_today").line1, "n/a");
  assert.equal(tiles.find(tile => tile.key === "trades_today").line2, "KEIN FENSTER");
});

test("MLB Teamform v3 fails closed for stale or authority-unsafe status", () => {
  const base = {
    record_type: "mlb_nextgen_team_form_paper_status_v2",
    observed_at_utc: "2026-08-09T18:00:00Z",
    paper_only: true,
    shadow_only: true,
    live_trading_authority: false,
    order_authority: "none",
    wallet_authority: "none",
    promotion_authority: "none",
    official_booked_pnl_cents: 0,
    ledger_integrity: "pass",
    team_form_cache: { status: "healthy" },
    settlement_freshness: { status: "healthy" }
  };
  const stale = buildMlbTeamFormV3Summary(base, NOW);
  assert.equal(stale.view_status, "warn");
  assert.equal(stale.view_status_label, "STALE");
  assert.match(stale.warnings.freshness, /veraltet/);
  const badLedger = buildMlbTeamFormV3Summary({ ...base, observed_at_utc: "2026-08-09T18:29:45Z", ledger_integrity: "failed" }, NOW);
  assert.equal(badLedger.view_status, "warn");
  assert.match(badLedger.warnings.ledger, /Ledger blockiert/);
  assert.equal(buildMlbTeamFormV3Summary({ ...base, observed_at_utc: "2026-08-09T18:29:45Z", order_authority: "paper" }, NOW).error, "MLB Teamform Authority blockiert");
  assert.match(buildMlbTeamFormV3Summary(null, NOW).error, /Status fehlt/);
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
  const bridgeSource = await readFile(new URL("../bridge/monitor-bridge.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(bridgeSource, /WEATHER_PUBLIC_|buildWeatherPublicSummary/);
});
