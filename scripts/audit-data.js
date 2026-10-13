#!/usr/bin/env node
/*
 * Contrôle des données de tirages : node scripts/audit-data.js
 * Vérifie data/draws.js (utilisé par index.html) et les archives JSON.
 * Code de sortie 1 si une anomalie bloquante est détectée.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const E = require('../lib/stats-engine.js');

const ROOT = path.join(__dirname, '..');
let failures = 0;
const fail = function (msg) { failures++; console.log('  ÉCHEC  ' + msg); };
const ok = function (msg) { console.log('  OK     ' + msg); };

const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'data', 'draws.js'), 'utf8'), ctx);
const DATA = ctx.window.LVC_DATA;

['loto', 'euro'].forEach(function (game) {
  console.log('\n' + E.GAMES[game].name + ' (data/draws.js)');
  const a = E.auditDraws(DATA[game], game);
  const info = E.historyInfo(DATA[game], game);
  console.log('  ' + a.valid + ' tirages, du ' + a.first + ' au ' + a.last);
  a.invalid.length ? fail(a.invalid.length + ' tirage(s) invalide(s) : ' + JSON.stringify(a.invalid.slice(0, 3))) : ok('aucun tirage invalide');
  a.duplicateDates.length ? fail('doublons : ' + a.duplicateDates.join(', ')) : ok('aucun doublon de date');
  a.unsorted.length ? fail('ordre chronologique rompu : ' + a.unsorted.slice(0, 5).join(', ')) : ok('ordre chronologique');
  info.limits.forEach(fail);
  a.intervals.forEach(function (x) { console.log('  INFO   pause du calendrier : ' + x.from + ' → ' + x.to + ' (' + x.days + ' jours)'); });
  [10, 25, 50, 100].forEach(function (size) {
    const s = E.computeStats(DATA[game], game, size);
    const expBonus = E.GAMES[game].bonusCount * size;
    if (s.frequencies.mainTotal !== 5 * size || s.frequencies.bonusTotal !== expBonus) fail('sommes de contrôle sur ' + size + ' tirages');
  });
  ok('sommes de contrôle des fréquences sur 10/25/50/100 tirages');
});

console.log('\nArchives JSON');
const lotoJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'loto_historique.json'), 'utf8'));
const euroJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'euromillions_historique.json'), 'utf8'));
const keys = new Set(lotoJson.map(function (r) { return r.drawKey; }));
keys.size === lotoJson.length ? ok('loto_historique.json : ' + lotoJson.length + ' tirages, drawKey unique') : fail('drawKey Loto non unique');
const dupIds = lotoJson.length - new Set(lotoJson.map(function (r) { return r.drawId; })).size;
console.log('  INFO   ' + dupIds + ' drawId FDJ partagés (1er et 2e tirage du même jour, ancien Loto) : conservés, distingués par drawKey');
const newLoto = lotoJson.filter(function (r) { return r.format === 'loto_5_numeros_chance'; }).map(function (r) { return { date: r.date, nums: r.balls.slice().sort(function (x, y) { return x - y; }), bonus: [r.chance] }; });
JSON.stringify(newLoto) === JSON.stringify(DATA.loto) ? ok('nouveau Loto identique entre JSON et data/draws.js') : fail('divergence nouveau Loto JSON / data/draws.js');
const euro = euroJson.map(function (r) { return { date: r.date, nums: r.balls.slice().sort(function (x, y) { return x - y; }), bonus: r.stars.slice().sort(function (x, y) { return x - y; }) }; });
JSON.stringify(euro) === JSON.stringify(DATA.euro) ? ok('EuroMillions identique entre JSON et data/draws.js') : fail('divergence EuroMillions JSON / data/draws.js');
const days = new Set(lotoJson.concat(euroJson).map(function (r) { return r.day; }));
Array.from(days).every(function (d) { return d.length > 2; }) ? ok('jours au format unique : ' + Array.from(days).join(', ')) : fail('jours abrégés restants');

try {
  const out = require('./build-data.js').build();
  const stale = Object.keys(out.files).filter(function (rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8') !== out.files[rel]; });
  stale.length ? fail('fichiers à régénérer depuis data/fdj : ' + stale.join(', ')) : ok('fichiers générés à jour avec les CSV FDJ');
} catch (e) { fail('régénération impossible : ' + e.message); }

console.log('\n' + (failures ? failures + ' anomalie(s) bloquante(s).' : 'Aucune anomalie bloquante.'));
process.exit(failures ? 1 : 0);
