'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const SA = require('../lib/stats-advanced.js');
const GG = require('../lib/grid-generator.js');
const BT = require('../lib/backtest.js');

function synthetic(gameId, n, seed) {
  const r = GG.rng(seed);
  const max = gameId === 'loto' ? 49 : 50, bmax = gameId === 'loto' ? 10 : 12, bc = gameId === 'loto' ? 1 : 2;
  const start = new Date(gameId === 'loto' ? '2017-01-02' : '2017-01-03');
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(start.getTime() + i * 3.5 * 86400000);
    const w = Array(max + 1).fill(1); w[0] = 0;
    const wb = Array(bmax + 1).fill(1); wb[0] = 0;
    out.push({ date: d.toISOString().slice(0, 10), nums: GG.sampleWeighted(w, 5, r), bonus: GG.sampleWeighted(wb, bc, r) });
  }
  return out;
}

test('stats avancées : théorie des répétitions et des consécutifs', function () {
  const h = synthetic('loto', 600, 7);
  const a = SA.analyze(h, 'loto', { window: 100 });
  assert.ok(Math.abs(a.repeats.expectedMean - 25 / 49) < 1e-9);
  assert.ok(a.consecutive.expectedPercent > 30 && a.consecutive.expectedPercent < 40);
  const sumTheo = a.repeats.rows.reduce(function (s, r) { return s + r.expectedPercent; }, 0);
  assert.ok(Math.abs(sumTheo - 100) < 1e-6);
  assert.equal(a.uniformity.df, 48);
  assert.ok(a.uniformity.pValue > 0 && a.uniformity.pValue <= 1);
});

test('stats avancées : asOf exclut le tirage du jour et les suivants', function () {
  const h = synthetic('loto', 300, 3);
  const cut = h[200].date;
  const a = SA.analyze(h, 'loto', { asOf: cut });
  assert.equal(a.historyDraws, 200);
});

test('p-valeurs : bornes de la loi normale et du khi-deux', function () {
  assert.ok(Math.abs(SA.normalCdf(0) - 0.5) < 1e-7);
  assert.ok(Math.abs(SA.twoSidedP(1.96) - 0.05) < 1e-3);
  assert.ok(Math.abs(SA.chiSquarePValue(48, 48) - 0.47) < 0.03);
});

test('générateur : grilles valides, reproductibles et diversifiées', function () {
  const h = synthetic('euro', 500, 11);
  ['opt', 'bal', 'hot', 'cold', 'late', 'rnd'].forEach(function (s) {
    const a = GG.generate(h, 'euro', { strategy: s, count: 5, seed: 42, maxOverlap: 2 });
    const b = GG.generate(h, 'euro', { strategy: s, count: 5, seed: 42, maxOverlap: 2 });
    assert.deepEqual(a.map(function (x) { return x.nums; }), b.map(function (x) { return x.nums; }));
    assert.equal(a.length, 5);
    a.forEach(function (x, i) {
      assert.equal(new Set(x.nums).size, 5);
      assert.ok(x.nums.every(function (n) { return n >= 1 && n <= 50; }));
      assert.equal(new Set(x.bonus).size, 2);
      assert.ok(x.bonus.every(function (n) { return n >= 1 && n <= 12; }));
      for (let j = 0; j < i; j++) assert.ok(GG.overlap(x.nums, a[j].nums) <= 2);
    });
  });
});

test('générateur : les stratégies contrôlées respectent toutes les contraintes', function () {
  const h = synthetic('loto', 500, 5);
  const grids = GG.generate(h, 'loto', { strategy: 'bal', count: 10, seed: 9, maxOverlap: 3 });
  grids.forEach(function (g) { assert.equal(g.conformity, 100); });
});

test('générateur : pondérations bornées (aucun numéro exclu ni imposé)', function () {
  const h = synthetic('loto', 400, 2);
  ['hot', 'cold', 'late', 'opt'].forEach(function (s) {
    const w = GG.weights(s, h, 'loto', 'main', 100, 1).slice(1);
    const ratio = Math.max.apply(null, w) / Math.min.apply(null, w);
    assert.ok(ratio <= Math.exp(4) + 1e-9, s + ' ratio ' + ratio);
  });
  const u = GG.weights('rnd', h, 'loto', 'main', 100, 1).slice(1);
  assert.ok(u.every(function (x) { return x === 1; }));
});

test('backtest : chronologique, déterministe et proche de la théorie sur des tirages uniformes', function () {
  const h = synthetic('loto', 700, 13);
  const a = BT.run(h, 'loto', { window: 100, gridsPerDraw: 2, seed: 1 });
  const b = BT.run(h, 'loto', { window: 100, gridsPerDraw: 2, seed: 1 });
  assert.equal(JSON.stringify(a.validation.rows), JSON.stringify(b.validation.rows));
  assert.equal(a.testedDraws, 500);
  assert.ok(a.development.to < a.validation.from);
  a.validation.rows.forEach(function (r) {
    assert.ok(Math.abs(r.mean - a.theoreticalMean) < 0.12, r.strategy + ' ' + r.mean);
  });
});

test('backtest : un tirage en double est ignoré et ne peut pas servir à se prédire lui-même', function () {
  const h = synthetic('loto', 260, 4);
  h.push(Object.assign({}, h[h.length - 1]));
  const r = BT.run(h, 'loto', { window: 100, gridsPerDraw: 1, seed: 2 });
  assert.equal(r.historyDraws, 260);
});
