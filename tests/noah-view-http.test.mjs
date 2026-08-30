import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("HTTP selector migrates legacy Native95 and cycles paper lanes separately from What-if", async () => {
  const port = 47831;
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataDir = await mkdtemp(path.join(tmpdir(), "streamdeck-view-test-"));
  await writeFile(path.join(dataDir, "noah-view.json"), `${JSON.stringify({ market: "mamba_native95", updatedAt: "2026-08-01T00:00:00Z" })}\n`);
  const child = spawn(process.execPath, ["bridge/monitor-bridge.mjs", "serve"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      CODEX_MONITOR_PORT: String(port),
      CODEX_MONITOR_HOST: "127.0.0.1",
      CODEX_MONITOR_DATA_DIR: dataDir,
      CODEX_MONITOR_AGENT_PUSH_ONLY: "1"
    },
    stdio: "ignore"
  });

  try {
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        ready = (await fetch(`${baseUrl}/health`)).ok;
      } catch {}
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(ready, true);

    assert.equal((await (await fetch(`${baseUrl}/noah/market`)).json()).market, "paper_primary");
    await writeFile(path.join(dataDir, "noah-view.json"), `${JSON.stringify({ market: "mlb_team_form_v3", updatedAt: "2026-08-02T00:00:00Z" })}\n`);
    assert.equal((await (await fetch(`${baseUrl}/noah/market`)).json()).market, "paper_primary");
    const seen = [];
    for (let index = 0; index < 3; index += 1) {
      const response = await fetch(`${baseUrl}/noah/market/next`, { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
      assert.equal(response.status, 200);
      const payload = await response.json();
      seen.push(payload.market);
      assert.deepEqual(payload.order, ["paper_primary", "paper_challenger", "mamba_transfer_52_95"]);
    }
    assert.deepEqual(seen, ["paper_challenger", "mamba_transfer_52_95", "paper_primary"]);

    const selected = await fetch(`${baseUrl}/noah/market`, {
      method: "POST",
      body: JSON.stringify({ market: "paper_challenger" }),
      headers: { "Content-Type": "application/json" }
    });
    assert.equal(selected.status, 200);
    assert.equal((await selected.json()).market, "paper_challenger");

    for (const market of ["weather_public", "btc", "crypto", "eu", "mlb_elo_v2", "mlb_team_form_v3"]) {
      const rejected = await fetch(`${baseUrl}/noah/market`, {
        method: "POST",
        body: JSON.stringify({ market }),
        headers: { "Content-Type": "application/json" }
      });
      assert.equal(rejected.status, 400, market);
    }
    assert.equal((await (await fetch(`${baseUrl}/noah/market`)).json()).market, "paper_challenger");
  } finally {
    child.kill("SIGTERM");
  }
});
