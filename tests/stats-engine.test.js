'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const E = require('../lib/stats-engine.js');

const ROOT = path.join(__dirname, '..');
const BACKUP = path.join(ROOT, 'data', 'sauvegarde-2026-10-13');

function loadAppData() {
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'data', 'draws.js'), 'utf8'), ctx);
  return { data: ctx.window.LVC_DATA, meta: ctx.window.LVC_DATA_META };
}

const LOTO = [
  { date: '2026-01-03', nums: [1, 2, 3, 4, 5], bonus: [1] },
  { date: '2026-01-05', nums: [1, 2, 3, 4, 6], bonus: [2] },
  { date: '2026-01-07', nums: [1, 7, 8, 9, 10], bonus: [2] },
  { date: '2026-01-10', nums: [11, 12, 13, 14, 49], bonus: [10] }
];
const EURO = [
  { date: '2026-01-02', nums: [1, 2, 3, 4, 50], bonus: [1, 12] },
  { date: '2026-01-06', nums: [1, 2, 3, 4, 5], bonus: [1, 2] },
  { date: '2026-01-09', nums: [6, 7, 8, 9, 10], bonus: [3, 12] }
];
const sum = (a) => a.reduce((x, y) => x + y, 0);

test('1. fréquences connues — Loto', () => {
  const f = E.frequencies(LOTO, 'loto', 'main');
  assert.equal(f.length, 50);
  assert.equal(f[1], 3);
  assert.equal(f[2], 2);
  assert.equal(f[49], 1);
  assert.equal(f[48], 0);
  const b = E.frequencies(LOTO, 'loto', 'bonus');
  assert.deepEqual(b.slice(1), [1, 2, 0, 0, 0, 0, 0, 0, 0, 1]);
});

test('1. fréquences connues — EuroMillions', () => {
  const f = E.frequencies(EURO, 'euro', 'main');
  assert.equal(f.length, 51);
  assert.equal(f[1], 2);
  assert.equal(f[50], 1);
  const s = E.frequencies(EURO, 'euro', 'bonus');
  assert.equal(s.length, 13);
  assert.equal(s[1], 2);
  assert.equal(s[12], 2);
  assert.equal(s[3], 1);
});

test('2-4. sommes de contrôle sur l’historique réel, pour 10/25/50/100 tirages', () => {
  const { data } = loadAppData();
  for (const size of [10, 25, 50, 100]) {
    const l = E.computeStats(data.loto, 'loto', size);
    assert.equal(l.window.analyzed, size);
    assert.equal(l.frequencies.mainTotal, 5 * size, 'Loto principaux ' + size);
    assert.equal(l.frequencies.bonusTotal, 1 * size, 'Chance ' + size);
    const e = E.computeStats(data.euro, 'euro', size);
    assert.equal(e.frequencies.mainTotal, 5 * size, 'Euro principaux ' + size);
    assert.equal(e.frequencies.bonusTotal, 2 * size, 'Étoiles ' + size);
  }
});

test('5. retard calculé sur tout l’historique, indépendamment de la période', () => {
  const g = E.gaps(LOTO, 'loto', 'main');
  assert.equal(g[11], 0);
  assert.equal(g[1], 1);
  assert.equal(g[5], 3);
  assert.equal(g[6], 2);
  assert.equal(g[48], null, 'jamais sorti => null, pas de retard inventé');
  const s2 = E.computeStats(LOTO, 'loto', 2);
  assert.equal(s2.gaps.main[5], 3, 'la fenêtre de 2 tirages ne plafonne pas le retard');
  assert.equal(s2.late.items[0].n, 15, 'jamais sorti classé en tête');
  assert.equal(s2.late.items[0].value, null);
});

test('5. erreurs de l’audit reproduites : Loto 19 et 27, EuroMillions 20', () => {
  const orig = JSON.parse(fs.readFileSync(path.join(BACKUP, 'DATA-index-html-origine.json'), 'utf8'));
  // Ancien calcul : retard limité à la fenêtre et plafonné à « tirages + 1 ».
  const oldGap = (a, max) => { const g = Array(max + 1).fill(a.length + 1); for (let i = a.length - 1; i >= 0; i--) a[i].nums.forEach((n) => { if (g[n] === a.length + 1) g[n] = a.length - 1 - i; }); return g; };
  assert.equal(oldGap(orig.loto.slice(-10), 49)[19], 11);
  assert.equal(oldGap(orig.loto.slice(-10), 49)[27], 11);
  assert.equal(oldGap(orig.euro.slice(-25), 50)[20], 26);
  for (const size of [10, 25, 50, 100]) {
    const l = E.computeStats(orig.loto, 'loto', size);
    assert.equal(l.gaps.main[19], 25);
    assert.equal(l.gaps.main[27], 30);
    assert.equal(E.computeStats(orig.euro, 'euro', size).gaps.main[20], 40);
  }
});

test('5. retards des complémentaires séparés', () => {
  const g = E.gaps(EURO, 'euro', 'bonus');
  assert.equal(g[12], 0);
  assert.equal(g[1], 1);
  assert.equal(g[2], 1);
  assert.equal(g[11], null);
});

test('6. égalités signalées dans les classements', () => {
  const values = [0, 5, 3, 3, 3, 1];
  const r = E.rank(values, [1, 2, 3, 4, 5], 'desc', 2);
  assert.deepEqual(r.items.map((x) => x.n), [1, 2]);
  assert.equal(r.cutoffValue, 3);
  assert.deepEqual(r.tiedOutside, [3, 4]);
  assert.deepEqual(r.tiedAtCutoff, [2, 3, 4]);
  const none = E.rank(values, [1, 2, 3, 4, 5], 'desc', 4);
  assert.deepEqual(none.tiedOutside, []);
  const s = E.computeStats(LOTO, 'loto', 4);
  assert.equal(s.cold.cutoffValue, 0);
  assert.ok(s.cold.tiedOutside.length > 0, '35 numéros jamais sortis : égalité signalée');
});

test('7. données vides : aucun NaN ni Infinity', () => {
  for (const game of ['loto', 'euro']) {
    const s = E.computeStats([], game, 10);
    assert.equal(s.window.analyzed, 0);
    assert.equal(s.sums, null);
    assert.equal(s.parity.percent.display.every((p) => p === null), true);
    assert.equal(s.history.complete, false);
    assert.match(s.history.limits[0], /Aucun tirage/);
    const json = JSON.stringify(s);
    assert.doesNotMatch(json, /NaN|Infinity/);
  }
  assert.deepEqual(E.computeStats(null, 'loto', 10).window.analyzed, 0);
  assert.equal(E.sumStats([]), null);
});

test('7. historique plus court que la période et historique incomplet', () => {
  const s = E.computeStats(LOTO, 'loto', 100);
  assert.equal(s.window.requested, 100);
  assert.equal(s.window.analyzed, 4);
  assert.equal(s.frequencies.mainTotal, 20);
  assert.equal(s.history.complete, false);
  assert.match(s.history.limits.join(' '), /incomplet/);
  const stats = E.sumStats(LOTO);
  assert.equal(stats.min, 15);
  assert.equal(stats.max, 99);
  assert.equal(stats.mean, (15 + 16 + 35 + 99) / 4);
  assert.equal(stats.median, (16 + 35) / 2);
});

test('8. doublons, dates invalides, numéros hors limites, tirages mal formés', () => {
  const bad = [
    LOTO[0],
    LOTO[0],
    { date: '2026-02-30', nums: [1, 2, 3, 4, 5], bonus: [1] },
    { date: '2026-01-12', nums: [1, 2, 3, 4, 50], bonus: [1] },
    { date: '2026-01-14', nums: [1, 1, 3, 4, 5], bonus: [1] },
    { date: '2026-01-17', nums: [1, 2, 3, 4], bonus: [11] },
    null,
    { date: '2026-01-19', nums: [1, 2, 3, 4, 5] }
  ];
  const a = E.auditDraws(bad, 'loto');
  assert.deepEqual(a.duplicateDates, ['2026-01-03']);
  assert.equal(a.invalid.length, 6);
  assert.match(a.invalid[0].errors[0], /date invalide/);
  assert.match(a.invalid[1].errors.join(), /hors limites/);
  assert.match(a.invalid[2].errors.join(), /répété/);
  assert.equal(E.cleanDraws(bad, 'loto').length, 1);
  assert.deepEqual(E.validateDraw({ date: '2010-05-07', nums: [1, 2, 3, 4, 5], bonus: [1, 10] }, 'euro').length, 1, '10 étoiles interdites avant mai 2011');
  assert.deepEqual(E.validateDraw({ date: '2016-09-30', nums: [1, 2, 3, 4, 5], bonus: [1, 12] }, 'euro'), []);
  const s = E.computeStats(bad, 'loto', 10);
  assert.equal(s.window.analyzed, 1);
  assert.doesNotMatch(JSON.stringify(s), /NaN|Infinity/);
});

test('pourcentages : dénominateur explicite et total exact de 100 %', () => {
  const p = E.percentages([1, 1, 1], 3);
  assert.equal(Math.round(sum(p.display) * 10), 1000);
  assert.deepEqual(p.display, [33.4, 33.3, 33.3]);
  const { data } = loadAppData();
  for (const size of [10, 25, 50, 100]) {
    for (const game of ['loto', 'euro']) {
      const s = E.computeStats(data[game], game, size);
      for (const d of [s.parity.percent.display, s.lowHigh.percent.display, s.decades.bins.map((b) => b.percent), s.sums.buckets.map((b) => b.percent)]) {
        assert.equal(Math.round(sum(d) * 10), 1000, game + ' ' + size);
      }
      assert.equal(sum(s.decades.bins.map((b) => b.count)), 5 * size);
    }
  }
});

test('9. concordance avec un recalcul indépendant sur les données affichées', () => {
  const { data } = loadAppData();
  for (const game of ['loto', 'euro']) {
    const hist = data[game];
    const max = game === 'loto' ? 49 : 50;
    for (const size of [10, 25, 50, 100]) {
      const s = E.computeStats(hist, game, size);
      const win = hist.slice(-size);
      for (let n = 1; n <= max; n++) {
        assert.equal(s.frequencies.main[n], win.filter((d) => d.nums.includes(n)).length);
        let last = -1;
        hist.forEach((d, i) => { if (d.nums.includes(n)) last = i; });
        assert.equal(s.gaps.main[n], last < 0 ? null : hist.length - 1 - last, game + ' n=' + n);
      }
      const hot = s.hot.items.map((x) => x.value);
      assert.deepEqual(hot, hot.slice().sort((a, b) => b - a));
      const allAtCutoff = Array.from({ length: max }, (_, i) => i + 1).filter((n) => s.frequencies.main[n] === s.hot.cutoffValue);
      assert.deepEqual(s.hot.tiedAtCutoff, allAtCutoff);
    }
  }
});

test('données réelles : historiques complets, sans trou ni doublon', () => {
  const { data, meta } = loadAppData();
  const l = E.auditDraws(data.loto, 'loto');
  const e = E.auditDraws(data.euro, 'euro');
  for (const a of [l, e]) {
    assert.equal(a.invalid.length, 0);
    assert.equal(a.duplicateDates.length, 0);
    assert.equal(a.unsorted.length, 0);
  }
  assert.equal(l.first, '2008-10-06');
  assert.equal(e.first, '2004-02-13');
  assert.equal(e.intervals.length, 0, 'plus de trou EuroMillions 2016-2019');
  assert.deepEqual(l.intervals.map((x) => x.from), ['2019-11-02'], 'seule pause : changement de formule FDJ de novembre 2019');
  assert.ok(data.euro.some((d) => d.date === '2018-01-02'));
  assert.ok(data.loto.some((d) => d.date === '2026-10-12'));
  assert.ok(data.euro.some((d) => d.date === '2026-10-09'));
  assert.equal(meta.loto.count, data.loto.length);
  assert.equal(E.historyInfo(data.euro, 'euro').complete, true);
});

test('données réelles : aucun tirage initial perdu ni modifié', () => {
  const { data } = loadAppData();
  const orig = JSON.parse(fs.readFileSync(path.join(BACKUP, 'DATA-index-html-origine.json'), 'utf8'));
  for (const game of ['loto', 'euro']) {
    const byDate = new Map(data[game].map((d) => [d.date, JSON.stringify(d)]));
    for (const d of orig[game]) assert.equal(byDate.get(d.date), JSON.stringify(d), game + ' ' + d.date);
  }
  const jsonLoto = JSON.parse(fs.readFileSync(path.join(ROOT, 'loto_historique.json'), 'utf8'));
  const ids1984010 = jsonLoto.filter((r) => r.drawId === '1984010');
  assert.equal(ids1984010.length, 2, 'les deux tirages du 1984010 (1er et 2e tirage) sont conservés');
  assert.notEqual(ids1984010[0].drawKey, ids1984010[1].drawKey);
  assert.equal(new Set(jsonLoto.map((r) => r.drawKey)).size, jsonLoto.length);
});

test('10. index.html utilise les données générées et le moteur', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(html, /<script src="data\/draws\.js"><\/script>/);
  assert.match(html, /<script src="lib\/stats-engine\.js"><\/script>/);
  assert.doesNotMatch(html, /const DATA=\{"loto"/, 'plus de copie embarquée divergente');
  assert.match(html, /StatsEngine\.computeStats\(rows\(\),game,win\)/);
  for (const page of ['Accueil', 'Stats', 'Mes numéros', 'Cagnottes', 'Mes gains', 'Résultats', 'Réglages']) {
    assert.ok(html.includes(page), 'page ' + page);
  }
  const i = html.indexOf('<script>', html.indexOf('lib/stats-engine.js'));
  assert.doesNotThrow(() => new vm.Script(html.slice(i + 8, html.indexOf('</script>', i))));
});

test('données générées à jour par rapport aux CSV officiels', () => {
  const { build } = require('../scripts/build-data.js');
  const out = build();
  for (const rel of Object.keys(out.files)) {
    assert.equal(fs.readFileSync(path.join(ROOT, rel), 'utf8'), out.files[rel], rel + ' doit être régénéré');
  }
});
