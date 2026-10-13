/*
 * Loto Votre Chance — backtest chronologique (walk-forward).
 * Pour chaque tirage testé, les grilles sont générées uniquement à partir des tirages
 * strictement antérieurs, puis comparées au tirage réel. Le hasard pur sert de référence.
 * Les résultats sont séparés en période de développement (70 % les plus anciens)
 * et période de validation (30 % les plus récents, jamais utilisés pour régler les méthodes).
 * Navigateur : window.Backtest. Node : require.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./stats-engine.js'), require('./stats-advanced.js'), require('./grid-generator.js'));
  else root.Backtest = factory(root.StatsEngine, root.StatsAdvanced, root.GridGenerator);
})(typeof self !== 'undefined' ? self : this, function (SE, SA, GG) {
  'use strict';

  function mean(a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : 0; }
  function variance(a) { const m = mean(a); return a.length > 1 ? a.reduce(function (s, x) { return s + (x - m) * (x - m); }, 0) / (a.length - 1) : 0; }

  // Espérance théorique du nombre de bons numéros pour une grille quelconque : k²/N.
  function theoreticalMean(gameId, kind) {
    const g = SE.getGame(gameId);
    return kind === 'bonus' ? g.bonusCount * g.bonusCount / g.bonusMax : g.mainCount * g.mainCount / g.mainMax;
  }
  function theoreticalDistribution(gameId) {
    const g = SE.getGame(gameId), N = g.mainMax, k = g.mainCount;
    return Array.from({ length: k + 1 }, function (_, r) { return SA.binom(k, r) * SA.binom(N - k, k - r) / SA.binom(N, k); });
  }

  function summarize(perDraw, gameId) {
    const k = SE.getGame(gameId).mainCount;
    const all = [].concat.apply([], perDraw.map(function (d) { return d.main; }));
    const drawMeans = perDraw.map(function (d) { return mean(d.main); });
    const dist = Array(k + 1).fill(0);
    all.forEach(function (m) { dist[m]++; });
    const bonusAll = [].concat.apply([], perDraw.filter(function (d) { return d.bonus; }).map(function (d) { return d.bonus; }));
    // Erreur type calculée sur les moyennes par tirage : les grilles d'un même tirage ne sont pas indépendantes.
    const se = Math.sqrt(variance(drawMeans) / Math.max(1, drawMeans.length));
    const m = mean(drawMeans);
    return {
      draws: perDraw.length, grids: all.length, mean: m, se: se,
      ci95: [m - 1.96 * se, m + 1.96 * se],
      distribution: dist.map(function (c, r) { return { matches: r, count: c, percent: all.length ? c / all.length * 100 : 0 }; }),
      atLeast2: all.length ? all.filter(function (x) { return x >= 2; }).length / all.length * 100 : 0,
      atLeast3: all.length ? all.filter(function (x) { return x >= 3; }).length / all.length * 100 : 0,
      best: all.length ? Math.max.apply(null, all) : 0,
      bonusMean: bonusAll.length ? mean(bonusAll) : null,
      drawMeans: drawMeans
    };
  }

  // Comparaison appariée tirage par tirage avec le hasard pur (mêmes tirages testés).
  function compare(a, ref) {
    const diffs = a.drawMeans.map(function (x, i) { return x - ref.drawMeans[i]; });
    const d = mean(diffs), se = Math.sqrt(variance(diffs) / Math.max(1, diffs.length));
    const z = se > 0 ? d / se : 0;
    return { diff: d, se: se, z: z, pValue: SA.twoSidedP(z) };
  }

  /* options : { strategies, window, gridsPerDraw, seed, minHistory, maxDraws, validationShare, onProgress } */
  function run(rawHistory, gameId, options) {
    const o = options || {};
    const g = SE.getGame(gameId);
    const history = SE.cleanDraws(rawHistory, gameId);
    const strategies = (o.strategies || ['opt', 'bal', 'hot', 'cold', 'late']).filter(function (s) { return s !== 'rnd'; }).concat('rnd');
    const windowSize = o.window || 100;
    const gridsPerDraw = o.gridsPerDraw || 3;
    const seed = o.seed == null ? 20261013 : o.seed;
    const minHistory = Math.max(windowSize, o.minHistory || 200);
    const startAll = Math.min(minHistory, history.length);
    const indices = [];
    for (let i = startAll; i < history.length; i++) indices.push(i);
    const tested = o.maxDraws ? indices.slice(-o.maxDraws) : indices;
    const split = Math.floor(tested.length * (1 - (o.validationShare == null ? 0.3 : o.validationShare)));
    const per = {};
    strategies.forEach(function (s) { per[s] = []; });
    let profile = null;
    tested.forEach(function (i, step) {
      const train = history.slice(0, i);
      const target = history[i];
      if (train[train.length - 1].date >= target.date) throw new Error('Fuite de données détectée au tirage ' + target.date);
      if (!profile || step % 50 === 0) profile = SA.structureProfile(train.slice(-400), gameId);
      const bonusComparable = target.date >= g.bonusRulesStart;
      strategies.forEach(function (s) {
        const grids = GG.generate(train, gameId, { strategy: s, window: windowSize, count: gridsPerDraw, seed: GG.hashSeed(seed, s, target.date), profile: profile, maxOverlap: 5, maxAttempts: 150 });
        const tgt = new Set(target.nums), tb = new Set(target.bonus);
        per[s].push({
          date: target.date,
          main: grids.map(function (x) { return x.nums.filter(function (n) { return tgt.has(n); }).length; }),
          bonus: bonusComparable ? grids.map(function (x) { return x.bonus.filter(function (n) { return tb.has(n); }).length; }) : null
        });
      });
      if (o.onProgress && step % 100 === 0) o.onProgress(step, tested.length);
    });

    function block(from, to) {
      const sums = {};
      strategies.forEach(function (s) { sums[s] = summarize(per[s].slice(from, to), gameId); });
      const ref = sums.rnd;
      const others = strategies.filter(function (s) { return s !== 'rnd'; });
      const rows = strategies.map(function (s) {
        const r = sums[s];
        const c = s === 'rnd' ? null : compare(r, ref);
        if (c) c.pAdjusted = Math.min(1, c.pValue * others.length);
        const out = Object.assign({ strategy: s, label: GG.STRATEGIES[s].label, vsRandom: c }, r);
        delete out.drawMeans;
        return out;
      });
      return {
        from: per.rnd[from] ? per.rnd[from].date : null,
        to: per.rnd[to - 1] ? per.rnd[to - 1].date : null,
        draws: to - from, rows: rows,
        significant: rows.filter(function (r) { return r.vsRandom && r.vsRandom.pAdjusted < 0.05; }).map(function (r) { return r.strategy; })
      };
    }

    const development = block(0, split);
    const validation = block(split, tested.length);
    const confirmed = validation.significant.filter(function (s) { return development.significant.indexOf(s) >= 0; });
    return {
      game: gameId, generatedAt: new Date().toISOString(), window: windowSize, gridsPerDraw: gridsPerDraw, seed: seed,
      historyDraws: history.length, testedDraws: tested.length,
      theoreticalMean: theoreticalMean(gameId, 'main'),
      theoreticalBonusMean: theoreticalMean(gameId, 'bonus'),
      theoreticalDistribution: theoreticalDistribution(gameId).map(function (p, r) { return { matches: r, percent: p * 100 }; }),
      development: development, validation: validation,
      confirmed: confirmed,
      verdict: confirmed.length
        ? 'Écart significatif sur les deux périodes pour : ' + confirmed.map(function (s) { return GG.STRATEGIES[s].label; }).join(', ') + '. À confirmer sur de futurs tirages.'
        : 'Aucune méthode ne fait mieux que le hasard de façon significative et reproductible.'
    };
  }

  return { run: run, summarize: summarize, compare: compare, theoreticalMean: theoreticalMean, theoreticalDistribution: theoreticalDistribution };
});
