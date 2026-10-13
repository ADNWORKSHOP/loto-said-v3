/*
 * Loto Votre Chance — indicateurs statistiques complémentaires.
 * Chaque indicateur est descriptif : il mesure le passé et ne prédit aucun tirage.
 * Règle anti-fuite : toute analyse « à une date » n'utilise que les tirages strictement antérieurs.
 * Navigateur : window.StatsAdvanced (après lib/stats-engine.js). Node : require.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./stats-engine.js'));
  else root.StatsAdvanced = factory(root.StatsEngine);
})(typeof self !== 'undefined' ? self : this, function (SE) {
  'use strict';

  function range(n) { return Array.from({ length: n }, function (_, i) { return i + 1; }); }
  function sum(a) { return a.reduce(function (x, y) { return x + y; }, 0); }
  function pool(d, kind) { return (kind === 'bonus' ? d.bonus : d.nums) || []; }

  function binom(n, k) {
    if (k < 0 || k > n) return 0;
    let r = 1;
    for (let i = 1; i <= k; i++) r = r * (n - k + i) / i;
    return r;
  }

  // Abramowitz-Stegun 7.1.26 (erreur < 1,5e-7).
  function normalCdf(z) {
    const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z / 2);
    return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
  }
  function twoSidedP(z) { return 2 * (1 - normalCdf(Math.abs(z))); }
  // Approximation de Wilson-Hilferty pour la queue droite du khi-deux.
  function chiSquarePValue(x, df) {
    if (df <= 0) return null;
    const z = (Math.pow(x / df, 1 / 3) - (1 - 2 / (9 * df))) / Math.sqrt(2 / (9 * df));
    return 1 - normalCdf(z);
  }

  function quantile(sorted, q) {
    if (!sorted.length) return null;
    const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  function before(history, date) {
    return date ? history.filter(function (d) { return d.date < date; }) : history.slice();
  }

  /* Écart de chaque numéro à l'espérance d'un tirage uniforme.
   * attendu = n·k/N, écart-type = √(n·p·(1−p)), z = (observé − attendu)/écart-type.
   * Le khi-deux (ddl N−1) teste l'uniformité globale ; il est légèrement conservateur
   * car les k numéros d'un tirage sont tirés sans remise. */
  function uniformityTest(draws, gameId, kind) {
    const g = SE.getGame(gameId);
    const max = kind === 'bonus' ? g.bonusMax : g.mainMax;
    const k = kind === 'bonus' ? g.bonusCount : g.mainCount;
    const n = draws.length;
    if (!n) return null;
    const f = SE.frequencies(draws, gameId, kind);
    const p = k / max, expected = n * p, sd = Math.sqrt(n * p * (1 - p));
    let chi2 = 0;
    const rows = range(max).map(function (num) {
      chi2 += Math.pow(f[num] - expected, 2) / expected;
      return { n: num, observed: f[num], expected: expected, z: (f[num] - expected) / sd };
    });
    const extremes = rows.slice().sort(function (a, b) { return Math.abs(b.z) - Math.abs(a.z) || a.n - b.n; });
    const pValue = chiSquarePValue(chi2, max - 1);
    return {
      draws: n, expected: expected, sd: sd, chi2: chi2, df: max - 1, pValue: pValue,
      // Avec N numéros, environ 5 % dépassent |z| > 1,96 par pur hasard.
      beyond2: rows.filter(function (r) { return Math.abs(r.z) > 1.96; }).length,
      expectedBeyond2: max * 0.05,
      rows: rows, extremes: extremes.slice(0, 6),
      uniformRejected: pValue != null && pValue < 0.01,
      enoughData: expected >= 5
    };
  }

  function pairStats(draws, gameId, limit) {
    const g = SE.getGame(gameId);
    const N = g.mainMax, k = g.mainCount, n = draws.length;
    if (!n) return null;
    const counts = new Map();
    draws.forEach(function (d) {
      const a = d.nums.slice().sort(function (x, y) { return x - y; });
      for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) {
        const key = a[i] * 100 + a[j];
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    });
    const p = k * (k - 1) / (N * (N - 1)), expected = n * p, sd = Math.sqrt(n * p * (1 - p));
    const rows = Array.from(counts, function (e) { return { a: Math.floor(e[0] / 100), b: e[0] % 100, count: e[1], z: (e[1] - expected) / sd }; })
      .sort(function (x, y) { return y.count - x.count || x.a - y.a || x.b - y.b; });
    return {
      draws: n, totalPairs: binom(N, 2), seenPairs: counts.size, expected: expected,
      top: rows.slice(0, limit || 8),
      // Avec 1 176 paires (Loto), les plus fréquentes dépassent l'attendu par simple effet du nombre.
      maxExpectedByChanceZ: Math.sqrt(2 * Math.log(binom(N, 2))),
      enoughData: expected >= 5
    };
  }

  function spreadStats(draws) {
    const s = draws.map(function (d) { return Math.max.apply(null, d.nums) - Math.min.apply(null, d.nums); }).sort(function (a, b) { return a - b; });
    if (!s.length) return null;
    return { count: s.length, mean: sum(s) / s.length, median: quantile(s, 0.5), p10: quantile(s, 0.1), p90: quantile(s, 0.9), min: s[0], max: s[s.length - 1] };
  }

  // Numéros principaux répétés d'un tirage au suivant ; espérance théorique k²/N.
  function repeatStats(draws, gameId) {
    const g = SE.getGame(gameId);
    if (draws.length < 2) return null;
    const dist = Array(g.mainCount + 1).fill(0);
    let total = 0;
    for (let i = 1; i < draws.length; i++) {
      const prev = new Set(draws[i - 1].nums);
      const r = draws[i].nums.filter(function (x) { return prev.has(x); }).length;
      dist[r]++; total += r;
    }
    const n = draws.length - 1, N = g.mainMax, k = g.mainCount;
    const theo = dist.map(function (_, r) { return binom(k, r) * binom(N - k, k - r) / binom(N, k); });
    return {
      transitions: n, mean: total / n, expectedMean: k * k / N,
      rows: dist.map(function (c, r) { return { repeated: r, count: c, percent: c / n * 100, expectedPercent: theo[r] * 100 }; })
    };
  }

  // Part des tirages contenant au moins deux numéros consécutifs, comparée à la théorie.
  function consecutiveStats(draws, gameId) {
    const g = SE.getGame(gameId);
    if (!draws.length) return null;
    const hit = draws.filter(function (d) {
      const a = d.nums.slice().sort(function (x, y) { return x - y; });
      return a.some(function (x, i) { return i && x - a[i - 1] === 1; });
    }).length;
    const N = g.mainMax, k = g.mainCount;
    return { draws: draws.length, withConsecutive: hit, percent: hit / draws.length * 100, expectedPercent: (1 - binom(N - k + 1, k) / binom(N, k)) * 100 };
  }

  /* Profil structurel d'un historique : zones dans lesquelles se situent la plupart
   * des tirages passés. Sert de garde-fou au générateur, pas de prédiction. */
  function structureProfile(draws, gameId) {
    const g = SE.getGame(gameId);
    const sums = draws.map(function (d) { return sum(d.nums); }).sort(function (a, b) { return a - b; });
    const spreads = draws.map(function (d) { return Math.max.apply(null, d.nums) - Math.min.apply(null, d.nums); }).sort(function (a, b) { return a - b; });
    const fallbackMid = g.mainCount * (g.mainMax + 1) / 2;
    return {
      draws: draws.length,
      sumMin: sums.length >= 30 ? Math.round(quantile(sums, 0.1)) : Math.round(fallbackMid * 0.7),
      sumMax: sums.length >= 30 ? Math.round(quantile(sums, 0.9)) : Math.round(fallbackMid * 1.3),
      spreadMin: spreads.length >= 30 ? Math.round(quantile(spreads, 0.1)) : Math.round(g.mainMax * 0.45),
      evenMin: 1, evenMax: g.mainCount - 1,
      lowMin: 1, lowMax: g.mainCount - 1,
      decadesMin: 3, maxConsecutive: 2, lowLimit: g.lowMax
    };
  }

  function analyze(rawHistory, gameId, options) {
    const o = options || {};
    const g = SE.getGame(gameId);
    const history = before(SE.cleanDraws(rawHistory, gameId), o.asOf);
    const win = o.window ? history.slice(-o.window) : history;
    const bonusHistory = history.filter(function (d) { return d.date >= g.bonusRulesStart; });
    return {
      game: gameId, asOf: o.asOf || null, historyDraws: history.length, windowDraws: win.length,
      uniformity: uniformityTest(history, gameId, 'main'),
      bonusUniformity: uniformityTest(bonusHistory, gameId, 'bonus'),
      recentUniformity: uniformityTest(win, gameId, 'main'),
      pairs: pairStats(history, gameId, 8),
      spread: spreadStats(win),
      historicSpread: spreadStats(history),
      repeats: repeatStats(history, gameId),
      consecutive: consecutiveStats(history, gameId),
      profile: structureProfile(history.slice(-400), gameId)
    };
  }

  return {
    binom: binom, normalCdf: normalCdf, twoSidedP: twoSidedP, chiSquarePValue: chiSquarePValue, quantile: quantile,
    before: before, uniformityTest: uniformityTest, pairStats: pairStats, spreadStats: spreadStats,
    repeatStats: repeatStats, consecutiveStats: consecutiveStats, structureProfile: structureProfile, analyze: analyze
  };
});
