#!/usr/bin/env node
/*
 * Backtest chronologique de toutes les méthodes : node scripts/backtest.js
 * Écrit data/backtest.js (lu par index.html) et data/backtest-results.json.
 * Graine fixe : deux exécutions sur le même historique donnent le même résultat.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const BT = require('../lib/backtest.js');

const ROOT = path.join(__dirname, '..');
const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'data', 'draws.js'), 'utf8'), ctx);
const DATA = ctx.window.LVC_DATA;

const out = {};
['loto', 'euro'].forEach(function (game) {
  const t = Date.now();
  const r = BT.run(DATA[game], game, { window: 100, gridsPerDraw: 3, seed: 20261013 });
  out[game] = r;
  console.log(game + ' : ' + r.testedDraws + ' tirages testés en ' + (Date.now() - t) + ' ms');
  ['development', 'validation'].forEach(function (k) {
    console.log('  ' + k + ' ' + r[k].from + ' → ' + r[k].to);
    r[k].rows.forEach(function (x) {
      console.log('    ' + x.label.padEnd(16) + ' moyenne ' + x.mean.toFixed(3) + (x.vsRandom ? '  p ajusté ' + x.vsRandom.pAdjusted.toFixed(3) : '  (référence)'));
    });
  });
  console.log('  ' + r.verdict);
});

fs.writeFileSync(path.join(ROOT, 'data', 'backtest-results.json'), JSON.stringify(out, null, 2) + '\n');
fs.writeFileSync(path.join(ROOT, 'data', 'backtest.js'),
  '/* Fichier généré par scripts/backtest.js. Ne pas modifier à la main. */\nwindow.LVC_BACKTEST=' + JSON.stringify(out) + ';\n');
