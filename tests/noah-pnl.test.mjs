import assert from "node:assert/strict";
import test from "node:test";

import {
  buildNoahSummaryFromObserverLive,
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
