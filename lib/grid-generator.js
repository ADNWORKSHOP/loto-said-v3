/*
 * Loto Votre Chance — générateur de grilles configurable.
 * Les pondérations orientent le choix des numéros selon une méthode, mais aucune
 * méthode ne modifie la probabilité réelle de gain : chaque combinaison a la même chance.
 * Navigateur : window.GridGenerator (après stats-engine.js et stats-advanced.js). Node : require.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./stats-engine.js'), require('./stats-advanced.js'));
  else root.GridGenerator = factory(root.StatsEngine, root.StatsAdvanced);
})(typeof self !== 'undefined' ? self : this, function (SE, SA) {
  'use strict';

  const STRATEGIES = {
    opt: { label: 'LA GRILLE SAID', short: 'Mixte', help: 'Pondération légère par fréquence récente et retard, avec une structure équilibrée.', constraints: true },
    bal: { label: 'Équilibrée', short: 'Équilibrée', help: 'Tous les numéros ont le même poids ; seule la structure (somme, parité, dizaines) est contrôlée.', constraints: true },
    hot: { label: 'Fréquents', short: 'Fréquents', help: 'Favorise les numéros sortis plus souvent que l’attendu sur la période choisie.', constraints: true },
    cold: { label: 'Rares', short: 'Rares', help: 'Favorise les numéros sortis moins souvent que l’attendu sur la période choisie.', constraints: true },
    late: { label: 'En retard', short: 'Retard', help: 'Favorise les numéros absents depuis le plus grand nombre de tirages.', constraints: true },
    rnd: { label: 'Hasard pur', short: 'Hasard', help: 'Tirage uniforme, sans pondération ni contrôle : la référence de comparaison.', constraints: false }
  };

  // Générateur pseudo-aléatoire reproductible (mulberry32).
  function rng(seed) {
    let a = (seed >>> 0) || 1;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashSeed() {
    let h = 2166136261;
    Array.prototype.slice.call(arguments).join('|').split('').forEach(function (c) { h = Math.imul(h ^ c.charCodeAt(0), 16777619); });
    return h >>> 0;
  }
  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
  function range(n) { return Array.from({ length: n }, function (_, i) { return i + 1; }); }

  /* Poids par numéro (index 1..max). strength ∈ [0 ; 1] : 0 = uniforme.
   * Les z-scores sont bornés à ±2 pour qu'aucun numéro ne devienne quasi certain ou exclu. */
  function weights(strategy, history, gameId, kind, windowSize, strength) {
    const g = SE.getGame(gameId);
    const max = kind === 'bonus' ? g.bonusMax : g.mainMax;
    const k = kind === 'bonus' ? g.bonusCount : g.mainCount;
    const s = strength == null ? 0.5 : clamp(strength, 0, 1);
    const w = Array(max + 1).fill(1); w[0] = 0;
    if (strategy === 'rnd' || strategy === 'bal' || s === 0) return w;
    const usable = kind === 'bonus' ? history.filter(function (d) { return d.date >= g.bonusRulesStart; }) : history;
    const win = usable.slice(-windowSize);
    const n = win.length;
    if (!n) return w;
    const f = SE.frequencies(win, gameId, kind);
    const p = k / max, sd = Math.sqrt(n * p * (1 - p)) || 1;
    const gp = SE.gaps(usable, gameId, kind);
    const expectedGap = max / k;
    range(max).forEach(function (num) {
      const zf = clamp((f[num] - n * p) / sd, -2, 2);
      const gapVal = gp[num] == null ? usable.length : gp[num];
      const zg = clamp((gapVal - expectedGap) / expectedGap, -2, 2);
      let z = 0;
      if (strategy === 'hot') z = zf;
      else if (strategy === 'cold') z = -zf;
      else if (strategy === 'late') z = zg;
      else z = (zf + zg) / 2;
      w[num] = Math.exp(s * z);
    });
    return w;
  }

  function sampleWeighted(w, k, random) {
    const avail = w.map(function (x, i) { return [i, x]; }).filter(function (e) { return e[1] > 0; });
    const out = [];
    while (out.length < k && avail.length) {
      let total = 0;
      avail.forEach(function (e) { total += e[1]; });
      let r = random() * total, idx = 0;
      while (idx < avail.length - 1 && r >= avail[idx][1]) { r -= avail[idx][1]; idx++; }
      out.push(avail.splice(idx, 1)[0][0]);
    }
    return out.sort(function (a, b) { return a - b; });
  }

  function structure(nums, gameId) {
    const g = SE.getGame(gameId);
    const a = nums.slice().sort(function (x, y) { return x - y; });
    let run = 1, maxRun = 1;
    for (let i = 1; i < a.length; i++) { run = a[i] - a[i - 1] === 1 ? run + 1 : 1; maxRun = Math.max(maxRun, run); }
    return {
      sum: a.reduce(function (x, y) { return x + y; }, 0),
      evens: a.filter(function (x) { return x % 2 === 0; }).length,
      low: a.filter(function (x) { return x <= g.lowMax; }).length,
      decades: new Set(a.map(function (x) { return Math.min(4, Math.floor((x - 1) / 10)); })).size,
      spread: a[a.length - 1] - a[0],
      maxRun: maxRun
    };
  }

  function checks(st, profile) {
    return [
      { id: 'sum', ok: st.sum >= profile.sumMin && st.sum <= profile.sumMax, label: 'Somme ' + st.sum + ' (zone habituelle ' + profile.sumMin + '–' + profile.sumMax + ')' },
      { id: 'even', ok: st.evens >= profile.evenMin && st.evens <= profile.evenMax, label: st.evens + ' pair(s) / ' + (5 - st.evens) + ' impair(s)' },
      { id: 'low', ok: st.low >= profile.lowMin && st.low <= profile.lowMax, label: st.low + ' bas (1–' + profile.lowLimit + ') / ' + (5 - st.low) + ' haut(s)' },
      { id: 'decades', ok: st.decades >= profile.decadesMin, label: st.decades + ' dizaines différentes' },
      { id: 'spread', ok: st.spread >= profile.spreadMin, label: 'Amplitude ' + st.spread + ' (minimum habituel ' + profile.spreadMin + ')' },
      { id: 'run', ok: st.maxRun <= profile.maxConsecutive, label: st.maxRun > 1 ? st.maxRun + ' numéros consécutifs' : 'Aucune suite de numéros consécutifs' }
    ];
  }

  function overlap(a, b) { const s = new Set(b); return a.filter(function (x) { return s.has(x); }).length; }

  /* options : { strategy, window, strength, count, seed, maxOverlap, avoid: [[nums]], profile, maxAttempts }
   * Retourne des grilles distinctes partageant au plus maxOverlap numéros entre elles
   * et avec les grilles à éviter (par exemple le dernier tirage). */
  function generate(history, gameId, options) {
    const o = options || {};
    const g = SE.getGame(gameId);
    const strategy = STRATEGIES[o.strategy] ? o.strategy : 'opt';
    const def = STRATEGIES[strategy];
    const windowSize = o.window || 100;
    const count = clamp(o.count || 1, 1, 10);
    const maxOverlap = o.maxOverlap == null ? 2 : o.maxOverlap;
    const random = rng(o.seed == null ? hashSeed(Date.now(), Math.random()) : o.seed);
    const profile = o.profile || SA.structureProfile(history.slice(-400), gameId);
    const wMain = weights(strategy, history, gameId, 'main', windowSize, o.strength);
    const wBonus = weights(strategy === 'opt' ? 'bal' : strategy, history, gameId, 'bonus', windowSize, o.strength);
    const avoid = (o.avoid || []).slice();
    const out = [];
    const maxAttempts = o.maxAttempts || 400;
    for (let gi = 0; gi < count; gi++) {
      let best = null;
      for (let t = 0; t < maxAttempts; t++) {
        const nums = sampleWeighted(wMain, g.mainCount, random);
        if (avoid.some(function (x) { return overlap(nums, x) > maxOverlap; })) continue;
        const c = checks(structure(nums, gameId), profile);
        const passed = c.filter(function (x) { return x.ok; }).length;
        if (!best || passed > best.passed) best = { nums: nums, checks: c, passed: passed };
        if (!def.constraints || passed === c.length) break;
      }
      if (!best) break;
      avoid.push(best.nums);
      const bonus = sampleWeighted(wBonus, g.bonusCount, random);
      out.push({
        game: gameId, strategy: strategy, nums: best.nums, bonus: bonus,
        structure: structure(best.nums, gameId),
        checks: best.checks,
        conformity: Math.round(best.passed / best.checks.length * 100),
        explanation: explain(best.nums, strategy, wMain, windowSize)
      });
    }
    return out;
  }

  function explain(nums, strategy, w, windowSize) {
    const def = STRATEGIES[strategy];
    const lines = [def.label + ' : ' + def.help];
    if (strategy !== 'rnd' && strategy !== 'bal') {
      const mean = w.slice(1).reduce(function (x, y) { return x + y; }, 0) / (w.length - 1);
      const up = nums.filter(function (n) { return w[n] > mean * 1.1; });
      if (up.length) lines.push('Numéros favorisés par la méthode (' + windowSize + ' derniers tirages) : ' + up.join(', ') + '.');
    }
    lines.push('Chaque combinaison garde exactement la même probabilité de gain.');
    return lines;
  }

  return { STRATEGIES: STRATEGIES, rng: rng, hashSeed: hashSeed, weights: weights, sampleWeighted: sampleWeighted, structure: structure, checks: checks, overlap: overlap, generate: generate };
});
