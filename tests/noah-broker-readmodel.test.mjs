import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildBrokerPaperLaneSummary, buildNoahTiles } from '../bridge/monitor-bridge.mjs';
const values=JSON.parse(readFileSync(new URL('./fixtures/broker_readmodels.json',import.meta.url)));
const canonical=JSON.parse(readFileSync(new URL('./fixtures/broker_readmodels_canonical.json',import.meta.url)));
function summary(name, validation='valid') {
  const model=structuredClone(values[name]);
  return buildBrokerPaperLaneSummary({contract_version:'streamdeck_tiles_v1',paper_lanes:{
    contract:'noah_us_ibkr_paper_lanes_operator_projection_v1',lanes:[{
      key: name==='partial'?'orb13':'native95',lane_id:model.lane_id,role:model.role,paper_only:true,
      freshness:{status:'fresh'},accounting:{status:'no_trades',booked_pnl_eur:null},
      trades:[],outcome_counts:{attempted:0,booked:0,filled:0,pending:0,no_fill:0,rejected:0},
      readmodel:model,readmodel_validation:{status:validation,canonical_json:canonical[name]}
    }]}},name==='partial'?'paper_challenger':'paper_primary');
}
test('same producer values: holiday closed with complete broker week',()=>{
  const s=summary('holiday'),tiles=buildNoahTiles(s);
  assert.equal(s.pnl.daily_eur,-243.2002);assert.equal(s.pnl.weekly_eur,-1523.7059);
  assert.equal(s.market_closed,true);assert.equal(s.cycle.trading,false);
  assert.equal(s.pnl.source_digest,values.holiday.source_digest);
  assert.equal(tiles.find(t=>t.key==='cycle').line2,'GESCHLOSSEN');
  assert.equal(tiles.find(t=>t.key==='trades_today').line1,'Geschlossen');
  assert.equal(tiles.find(t=>t.key==='weekly_pnl').line2,'VOLLSTÄNDIG');
  assert.equal(tiles.find(t=>t.key==='daily_pnl').footer,'2026-09-04');
});
test('missing ORB day stays partial while zero final day is a real zero',()=>{
  const s=summary('partial'),tiles=buildNoahTiles(s);
  assert.equal(s.pnl.daily_eur,0);assert.equal(s.pnl.weekly_eur,117.6217);
  assert.equal(s.pnl.weekly_partial,true);assert.equal(s.view_status,'warn');
  assert.equal(tiles.find(t=>t.key==='weekly_pnl').line2,'TEIL 2/5');
});
test('new session never inherits previous Friday PnL',()=>{
  const s=summary('preopen');assert.ok(Number.isNaN(s.pnl.daily_eur));
  assert.ok(Number.isNaN(s.pnl.weekly_eur));assert.equal(s.view_status_label,'VOR HANDELSSTART');
});
test('unvalidated producer model fails closed without legacy fallback',()=>{
  assert.ok(summary('holiday','unavailable').error);
  const source=readFileSync(new URL('../bridge/monitor-bridge.mjs',import.meta.url),'utf8');
  const probe=source.slice(source.indexOf('async function probeNoahMonitor'),source.indexOf('async function probeNoahMonitor')+3500);
  assert.ok(!probe.includes('return buildPaperLaneSummary'));
});

test('digest-bound canonical source rejects changed values and preserves Python float serialization',()=>{
  const before=values.holiday.day.pnl_eur;
  values.holiday.day.pnl_eur=999;
  assert.ok(summary('holiday').error);
  values.holiday.day.pnl_eur=before;
  assert.equal(summary('holiday').pnl.daily_eur,-243.2002);
});
