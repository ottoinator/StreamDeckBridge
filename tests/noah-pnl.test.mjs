import assert from "node:assert/strict";
import test from "node:test";

import {
  buildNoahSummaryFromObserverLive,
  buildNoahSummaryFromStreamdeckTiles,
  buildNoahTiles,
  portfolioWeekPnlEur
} from "../bridge/monitor-bridge.mjs";

test("weekly_pnl_eur zero is authoritative over stale realized total", () => {
  const pnl = portfolioWeekPnlEur({
    trade_day: "2026-06-15",
    current_portfolio_value_eur: 29947.9065,
    week_start_value_eur: 29947.9065,
    realized_pnl_eur_total: -52.0935,
    weekly_pnl_eur: 0
  });

  assert.equal(pnl, 0);
});

test("Noah weekly tile summary ignores stale realized total when weekly pnl is zero", () => {
  const summary = buildNoahSummaryFromObserverLive({
    generated_at_utc: "2026-06-15T09:05:40.000Z",
    active_market: "crypto",
    trade_day: "2026-06-15",
    markets: {
      us: {
        market: "us",
        trade_day: "2026-06-15",
        market_session_status: "closed",
        market_open: false,
        portfolio: {
          market: "us",
          trade_day: "2026-06-15",
          current_portfolio_value_eur: 29947.9065,
          week_start_value_eur: 29947.9065,
          realized_pnl_eur_total: -52.0935,
          daily_pnl_eur: 0,
          weekly_pnl_eur: 0,
          weekly_pnl_pct: 0
        },
        trade_activity: {
          trade_day: "2026-06-15",
          counts: { open_positions: 0, closed_trades: 0 }
        }
      },
      crypto: {
        market: "crypto",
        trade_day: "2026-06-15",
        market_session_status: "open",
        market_open: true,
        runtime_mode: {
          runtime_mode: "PAPER_CRYPTO_SPOT",
          next_cycle_ts_utc: "2026-06-15T09:10:40.000Z",
          cycle_interval_minutes: 1
        },
        portfolio: {
          market: "crypto",
          trade_day: "2026-06-15",
          realized_pnl_eur_total: 0,
          daily_pnl_eur: 0,
          weekly_pnl_eur: 0,
          weekly_pnl_pct: 0
        },
        trade_activity: {
          trade_day: "2026-06-15",
          counts: { open_positions: 0, closed_trades: 0 }
        }
      }
    },
    sessions: {
      us: { market_session_status: "closed" },
      crypto: { market_session_status: "open" }
    },
    trade_activity: {
      trade_day: "2026-06-15",
      counts: { open_positions: 0, closed_trades: 0 }
    }
  });

  assert.equal(summary.pnl.weekly_eur, 0);
  assert.equal(summary.pnl.daily_eur, 0);
  assert.deepEqual(summary.trades_today, { open: 0, closed: 0 });
});

test("Noah streamdeck tile contract drives PnL, trades, cycle, and live markets directly", () => {
  const summary = buildNoahSummaryFromStreamdeckTiles({
    contract_version: "streamdeck_tiles_v1",
    generated_at_utc: "2026-06-30T18:22:55Z",
    market: "combined",
    active_market: "us",
    active_market_status: "open",
    active_markets: ["us", "crypto"],
    cycle: {
      market: "us",
      market_label: "US",
      next_cycle_ts_utc: "2999-06-30T18:30:00Z",
      next_cycle_eta_seconds: 120,
      cycle_interval_minutes: 1,
      trading: true
    },
    pnl: {
      daily_eur: 226.9,
      daily_pct: 0.74,
      weekly_eur: 343.84,
      weekly_pct: 1.12
    },
    trades_today: {
      open: 0,
      closed: 2
    },
    live: {
      trading_markets: ["US", "CR"],
      trading_products: ["EQ", "CRY"],
      configured_markets: ["US", "CR"]
    },
    markets: {
      us: { market: "us", label: "US", product: "EQ", trading: true },
      crypto: { market: "crypto", label: "CR", product: "CRY", trading: true }
    }
  });

  assert.equal(summary.pnl.daily_eur, 226.9);
  assert.equal(summary.pnl.weekly_eur, 343.84);
  assert.deepEqual(summary.trades_today, { open: 0, closed: 2 });
  assert.deepEqual(summary.live.trading_markets, ["US", "CR"]);

  const tiles = buildNoahTiles(summary);
  assert.equal(tiles.find(tile => tile.key === "daily_pnl").line1, "+226,9 EUR");
  assert.equal(tiles.find(tile => tile.key === "weekly_pnl").line1, "+343,84 EUR");
  assert.equal(tiles.find(tile => tile.key === "trades_today").line2, "Close 2");
  assert.equal(tiles.find(tile => tile.key === "live_markets").line1, "US CR");
  assert.equal(tiles.find(tile => tile.key === "live_markets").footer, "View COMB");
});

test("Noah live-market tile reflects selected single-market view without changing trading truth", () => {
  const summary = buildNoahSummaryFromStreamdeckTiles({
    contract_version: "streamdeck_tiles_v1",
    generated_at_utc: "2026-07-01T09:00:00Z",
    market: "prediction_markets",
    active_market: "prediction_markets",
    active_market_status: "stale",
    active_markets: [],
    cycle: {
      market: "prediction_markets",
      market_label: "PM",
      next_cycle_ts_utc: null,
      next_cycle_eta_seconds: null,
      cycle_interval_minutes: 10,
      trading: false
    },
    pnl: {
      daily_eur: 0,
      daily_pct: 0,
      weekly_eur: 0,
      weekly_pct: 0
    },
    trades_today: {
      open: 0,
      closed: 0
    },
    live: {
      trading_markets: [],
      trading_products: [],
      configured_markets: ["PM"],
      configured_products: ["PM"]
    },
    markets: {
      prediction_markets: {
        market: "prediction_markets",
        label: "PM",
        product: "PM",
        trading: false,
        market_session_status: "stale"
      }
    }
  });

  assert.equal(summary.selected_market, "prediction_markets");
  assert.equal(summary.market_closed, true);
  const tiles = buildNoahTiles(summary);
  const liveTile = tiles.find(tile => tile.key === "live_markets");
  assert.equal(liveTile.status, "idle");
  assert.equal(liveTile.line1, "-");
  assert.equal(liveTile.footer, "PM");
  assert.equal(tiles.find(tile => tile.key === "daily_pnl").line1, "0,00 EUR");
  assert.equal(tiles.find(tile => tile.key === "trades_today").line1, "Geschlossen");
});

test("Noah zero daily PnL tile stays ok while selected prediction market is trading", () => {
  const summary = buildNoahSummaryFromStreamdeckTiles({
    contract_version: "streamdeck_tiles_v1",
    generated_at_utc: "2026-07-03T11:33:57Z",
    market: "prediction_markets",
    active_market: "prediction_markets",
    active_market_status: "open",
    active_markets: ["prediction_markets"],
    cycle: {
      market: "prediction_markets",
      market_label: "PM",
      next_cycle_ts_utc: "2999-07-03T11:40:00Z",
      next_cycle_eta_seconds: 0,
      cycle_interval_minutes: 10,
      trading: true
    },
    pnl: {
      daily_eur: 0,
      daily_pct: 0,
      weekly_eur: -136.75,
      weekly_pct: 0
    },
    trades_today: {
      open: 0,
      closed: 0
    },
    live: {
      trading_markets: ["PM"],
      trading_products: ["PM"],
      configured_markets: ["PM"],
      configured_products: ["PM"]
    },
    markets: {
      prediction_markets: {
        market: "prediction_markets",
        label: "PM",
        product: "PM",
        trading: true,
        market_session_status: "open",
        market_open: true
      }
    }
  });

  const tiles = buildNoahTiles(summary);

  assert.equal(tiles.find(tile => tile.key === "live_markets").status, "ok");
  assert.equal(tiles.find(tile => tile.key === "daily_pnl").line1, "0,00 EUR");
  assert.equal(tiles.find(tile => tile.key === "daily_pnl").status, "ok");
  assert.equal(tiles.find(tile => tile.key === "weekly_pnl").status, "error");
});

test("Noah daily and weekly PnL remain visible when no market is currently trading", () => {
  const summary = buildNoahSummaryFromStreamdeckTiles({
    contract_version: "streamdeck_tiles_v1",
    generated_at_utc: "2026-06-30T22:05:00Z",
    active_markets: [],
    cycle: {
      market: null,
      trading: false
    },
    pnl: {
      daily_eur: 125,
      daily_pct: 0.4167,
      weekly_eur: 180,
      weekly_pct: 0.6
    },
    trades_today: {
      open: 0,
      closed: 2
    },
    live: {
      trading_markets: [],
      trading_products: [],
      configured_markets: ["US", "CR"]
    },
    markets: {}
  });

  const tiles = buildNoahTiles(summary);
  assert.equal(tiles.find(tile => tile.key === "daily_pnl").line1, "+125 EUR");
  assert.equal(tiles.find(tile => tile.key === "daily_pnl").line2, "+0.42%");
  assert.equal(tiles.find(tile => tile.key === "weekly_pnl").line1, "+180 EUR");
  assert.equal(tiles.find(tile => tile.key === "live_markets").line1, "-");
  assert.equal(tiles.find(tile => tile.key === "live_markets").footer, "US CR");
});

test("Noah cycle tile uses compact ETA when the absolute cycle timestamp is stale", () => {
  const summary = buildNoahSummaryFromStreamdeckTiles({
    contract_version: "streamdeck_tiles_v1",
    generated_at_utc: "2026-07-01T04:52:55Z",
    cycle: {
      market: "crypto",
      market_label: "CR",
      next_cycle_ts_utc: "2026-07-01T04:51:11Z",
      next_cycle_eta_seconds: 42,
      cycle_interval_minutes: 10,
      trading: true
    },
    pnl: { daily_eur: 0, daily_pct: 0, weekly_eur: 0, weekly_pct: 0 },
    trades_today: { open: 0, closed: 0 },
    live: { trading_markets: ["CR"], trading_products: ["CRY"], configured_markets: ["US", "CR"] },
    markets: {}
  });

  const tiles = buildNoahTiles(summary);
  const cycleTile = tiles.find(tile => tile.key === "cycle");
  assert.equal(cycleTile.status, "ok");
  assert.notEqual(cycleTile.line1, "--:--");
  assert.equal(cycleTile.footer, "Naechste");
});
