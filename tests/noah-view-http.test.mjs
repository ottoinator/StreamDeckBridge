import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("HTTP market selector persists and cycles only through the three requested views", async () => {
  const port = 47831;
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataDir = await mkdtemp(path.join(tmpdir(), "streamdeck-view-test-"));
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

    assert.equal((await (await fetch(`${baseUrl}/noah/market`)).json()).market, "us");
    const seen = [];
    for (let index = 0; index < 3; index += 1) {
      const response = await fetch(`${baseUrl}/noah/market/next`, { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
      assert.equal(response.status, 200);
      const payload = await response.json();
      seen.push(payload.market);
      assert.deepEqual(payload.order, ["us", "mlb_elo_v2", "weather_public"]);
    }
    assert.deepEqual(seen, ["mlb_elo_v2", "weather_public", "us"]);

    const selected = await fetch(`${baseUrl}/noah/market`, {
      method: "POST",
      body: JSON.stringify({ market: "weather_public" }),
      headers: { "Content-Type": "application/json" }
    });
    assert.equal(selected.status, 200);
    assert.equal((await selected.json()).market, "weather_public");

    const rejected = await fetch(`${baseUrl}/noah/market`, {
      method: "POST",
      body: JSON.stringify({ market: "eu" }),
      headers: { "Content-Type": "application/json" }
    });
    assert.equal(rejected.status, 400);
    assert.equal((await (await fetch(`${baseUrl}/noah/market`)).json()).market, "weather_public");
  } finally {
    child.kill("SIGTERM");
  }
});
