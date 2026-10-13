/*
 * Loto Votre Chance — moteur statistique.
 * Fonctionne dans le navigateur (window.StatsEngine) et dans Node (require).
 * Historique attendu en ordre chronologique croissant :
 * [{ date: 'AAAA-MM-JJ', nums: [5 numéros], bonus: [Chance] | [2 étoiles] }].
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StatsEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const GAMES = {
    loto: {
      id: 'loto', name: 'LOTO', mainCount: 5, mainMax: 49, bonusCount: 1, bonusMax: 10, bonusLabel: 'Chance',
      lowMax: 24,
      rulesStart: '2008-10-06',
      bonusRulesStart: '2008-10-06',
      bonusMaxAt: function () { return 10; },
      // Lundi, mercredi, samedi : au plus 3 jours entre deux tirages.
      maxIntervalDays: function () { return 3; }
    },
    euro: {
      id: 'euro', name: 'EUROMILLIONS', mainCount: 5, mainMax: 50, bonusCount: 2, bonusMax: 12, bonusLabel: 'Étoiles',
      lowMax: 25,
      rulesStart: '2004-02-13',
      // 9 étoiles jusqu'au 06/05/2011, 11 jusqu'au 23/09/2016, 12 depuis le 27/09/2016.
      bonusRulesStart: '2016-09-27',
      bonusMaxAt: function (date) { return date < '2011-05-10' ? 9 : date < '2016-09-27' ? 11 : 12; },
      // Vendredi seul jusqu'en mai 2011, puis mardi et vendredi.
      maxIntervalDays: function (date) { return date < '2011-05-10' ? 7 : 4; }
    }
  };

  function getGame(gameId) {
    const g = GAMES[gameId];
    if (!g) throw new Error('Jeu inconnu : ' + gameId);
    return g;
  }

  function isValidISODate(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const d = new Date(s + 'T12:00:00Z');
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }

  function daysBetween(a, b) {
    return Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000);
  }

  function checkNumbers(list, count, max, label, errors) {
    if (!Array.isArray(list)) { errors.push(label + ' absents'); return; }
    if (list.length !== count) errors.push(label + ' : ' + list.length + ' au lieu de ' + count);
    list.forEach(function (n) {
      if (!Number.isInteger(n)) errors.push(label + ' : valeur non entière (' + n + ')');
      else if (n < 1 || n > max) errors.push(label + ' : ' + n + ' hors limites (1-' + max + ')');
    });
    if (new Set(list).size !== list.length) errors.push(label + ' : numéro répété');
  }

  function validateDraw(draw, gameId) {
    const g = getGame(gameId);
    if (!draw || typeof draw !== 'object') return ['tirage mal formé'];
    const errors = [];
    const dateOk = isValidISODate(draw.date);
    if (!dateOk) errors.push('date invalide (' + draw.date + ')');
    checkNumbers(draw.nums, g.mainCount, g.mainMax, 'numéros', errors);
    checkNumbers(draw.bonus, g.bonusCount, dateOk ? g.bonusMaxAt(draw.date) : g.bonusMax, g.bonusLabel, errors);
    return errors;
  }

  function auditDraws(draws, gameId) {
    const g = getGame(gameId);
    const report = { game: gameId, count: 0, valid: 0, invalid: [], duplicateDates: [], unsorted: [], intervals: [], first: null, last: null };
    if (!Array.isArray(draws)) { report.invalid.push({ index: -1, date: null, errors: ['historique absent ou non tableau'] }); return report; }
    report.count = draws.length;
    const seen = new Set();
    let prev = null;
    draws.forEach(function (d, index) {
      const errors = validateDraw(d, gameId);
      if (errors.length) { report.invalid.push({ index: index, date: d && d.date, errors: errors }); return; }
      report.valid++;
      if (seen.has(d.date)) { report.duplicateDates.push(d.date); return; }
      seen.add(d.date);
      if (prev) {
        if (d.date < prev) report.unsorted.push(d.date);
        else {
          const days = daysBetween(prev, d.date);
          if (days > g.maxIntervalDays(d.date)) report.intervals.push({ from: prev, to: d.date, days: days });
        }
      }
      prev = d.date;
      if (!report.first || d.date < report.first) report.first = d.date;
      if (!report.last || d.date > report.last) report.last = d.date;
    });
    return report;
  }

  // Ne garde que les tirages valides, un par date, triés chronologiquement.
  function cleanDraws(draws, gameId) {
    if (!Array.isArray(draws)) return [];
    const byDate = new Map();
    draws.forEach(function (d) {
      if (validateDraw(d, gameId).length === 0 && !byDate.has(d.date)) byDate.set(d.date, d);
    });
    return Array.from(byDate.values()).sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
  }

  function selectWindow(history, size) {
    const list = Array.isArray(history) ? history : [];
    const draws = size > 0 ? list.slice(-size) : [];
    return {
      draws: draws, requested: size, analyzed: draws.length,
      first: draws.length ? draws[0].date : null,
      last: draws.length ? draws[draws.length - 1].date : null
    };
  }

  function pool(draw, kind) { return (kind === 'bonus' ? draw.bonus : draw.nums) || []; }
  function maxFor(g, kind) { return kind === 'bonus' ? g.bonusMax : g.mainMax; }
  function range(n) { return Array.from({ length: n }, function (_, i) { return i + 1; }); }
  function sum(a) { return a.reduce(function (x, y) { return x + y; }, 0); }

  function frequencies(draws, gameId, kind) {
    const max = maxFor(getGame(gameId), kind);
    const f = new Array(max + 1).fill(0);
    (draws || []).forEach(function (d) {
      pool(d, kind).forEach(function (n) { if (Number.isInteger(n) && n >= 1 && n <= max) f[n]++; });
    });
    return f;
  }

  // Tirages écoulés depuis la dernière apparition, calculés sur tout l'historique fourni.
  // 0 = sorti au dernier tirage ; null = aucune apparition dans l'historique disponible.
  function gaps(history, gameId, kind) {
    const max = maxFor(getGame(gameId), kind);
    const out = new Array(max + 1).fill(null);
    const list = history || [];
    let remaining = max;
    for (let i = list.length - 1; i >= 0 && remaining > 0; i--) {
      pool(list[i], kind).forEach(function (n) {
        if (n >= 1 && n <= max && out[n] === null) { out[n] = list.length - 1 - i; remaining--; }
      });
    }
    out[0] = null;
    return out;
  }

  // Classement avec égalités explicites : les ex aequo sont départagés par numéro croissant
  // et ceux qui dépassent la limite sont renvoyés dans tiedOutside.
  // Une valeur null (jamais sorti) est classée en tête en ordre décroissant.
  function rank(values, numbers, order, limit) {
    const key = function (v) { return v === null || v === undefined ? (order === 'desc' ? Infinity : -Infinity) : v; };
    const sorted = numbers.slice().sort(function (a, b) {
      const va = key(values[a]), vb = key(values[b]);
      if (va !== vb) return order === 'desc' ? (vb > va ? 1 : -1) : (va > vb ? 1 : -1);
      return a - b;
    });
    const items = sorted.slice(0, limit).map(function (n) { return { n: n, value: values[n] }; });
    if (!items.length) return { items: [], cutoffValue: null, tiedOutside: [], tiedAtCutoff: [] };
    const cutoff = items[items.length - 1].value;
    const same = function (n) { return key(values[n]) === key(cutoff); };
    return { items: items, cutoffValue: cutoff, tiedOutside: sorted.slice(limit).filter(same), tiedAtCutoff: sorted.filter(same) };
  }

  // Pourcentages calculés depuis les valeurs exactes ; l'affichage (1 décimale) est
  // ajusté par la méthode du plus fort reste pour totaliser exactement 100 %.
  function percentages(counts, total) {
    if (!total) return { exact: counts.map(function () { return null; }), display: counts.map(function () { return null; }) };
    const exact = counts.map(function (c) { return (c / total) * 100; });
    const tenths = exact.map(function (p) { return Math.floor(p * 10 + 1e-9); });
    let missing = Math.round(sum(counts) / total * 1000) - sum(tenths);
    const order = exact
      .map(function (p, i) { return { i: i, r: p * 10 - tenths[i] }; })
      .sort(function (a, b) { return b.r - a.r || a.i - b.i; });
    for (let k = 0; missing > 0 && k < order.length; k++, missing--) tenths[order[k].i]++;
    return { exact: exact, display: tenths.map(function (t) { return t / 10; }) };
  }

  function parityDistribution(draws, gameId) {
    const g = getGame(gameId);
    const list = draws || [];
    const counts = new Array(g.mainCount + 1).fill(0);
    list.forEach(function (d) { counts[d.nums.filter(function (n) { return n % 2 === 0; }).length]++; });
    return {
      total: list.length,
      rows: counts.map(function (c, even) { return { even: even, odd: g.mainCount - even, count: c }; }),
      percent: percentages(counts, list.length)
    };
  }

  function lowHighDistribution(draws, gameId) {
    const g = getGame(gameId);
    const list = draws || [];
    const counts = new Array(g.mainCount + 1).fill(0);
    let lowBalls = 0;
    list.forEach(function (d) {
      const low = d.nums.filter(function (n) { return n <= g.lowMax; }).length;
      counts[low]++;
      lowBalls += low;
    });
    const totalBalls = list.length * g.mainCount;
    return {
      total: list.length,
      lowRange: '1–' + g.lowMax,
      highRange: (g.lowMax + 1) + '–' + g.mainMax,
      rows: counts.map(function (c, low) { return { low: low, high: g.mainCount - low, count: c }; }),
      percent: percentages(counts, list.length),
      ballShare: percentages([lowBalls, totalBalls - lowBalls], totalBalls)
    };
  }

  function decadeDistribution(draws, gameId) {
    const g = getGame(gameId);
    const list = draws || [];
    const bins = [];
    for (let from = 1; from <= g.mainMax; from += 10) bins.push({ from: from, to: Math.min(from + 9, g.mainMax), count: 0 });
    list.forEach(function (d) { d.nums.forEach(function (n) { bins[Math.floor((n - 1) / 10)].count++; }); });
    const totalBalls = list.length * g.mainCount;
    const pct = percentages(bins.map(function (b) { return b.count; }), totalBalls);
    return {
      totalBalls: totalBalls,
      bins: bins.map(function (b, i) { return { from: b.from, to: b.to, count: b.count, label: b.from + '–' + b.to, percent: pct.display[i], exact: pct.exact[i] }; })
    };
  }

  const SUM_BUCKETS = [[0, 74], [75, 99], [100, 124], [125, 149], [150, 174], [175, 199], [200, Infinity]];

  // null si aucun tirage : jamais de NaN ni d'Infinity.
  function sumStats(draws) {
    const sums = (draws || []).map(function (d) { return sum(d.nums); });
    if (!sums.length) return null;
    const sorted = sums.slice().sort(function (a, b) { return a - b; });
    const mid = Math.floor(sorted.length / 2);
    const counts = SUM_BUCKETS.map(function (b) { return sums.filter(function (s) { return s >= b[0] && s <= b[1]; }).length; });
    const pct = percentages(counts, sums.length);
    return {
      count: sums.length,
      mean: sum(sums) / sums.length,
      median: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      buckets: SUM_BUCKETS.map(function (b, i) {
        const label = b[1] === Infinity ? '≥ ' + b[0] : b[0] === 0 ? '≤ ' + b[1] : b[0] + '–' + b[1];
        return { label: label, count: counts[i], percent: pct.display[i] };
      })
    };
  }

  // Taux d'apparition (en %) = apparitions / tirages analysés, pour chaque période.
  function compareRecentHistoric(recent, historic, gameId, kind, limit) {
    const g = getGame(gameId);
    const nr = (recent || []).length, nh = (historic || []).length;
    if (!nr || !nh) return { recentDraws: nr, historicDraws: nh, above: [], below: [] };
    const fr = frequencies(recent, gameId, kind), fh = frequencies(historic, gameId, kind);
    const rows = range(maxFor(g, kind)).map(function (n) {
      const rr = fr[n] / nr * 100, rh = fh[n] / nh * 100;
      return { n: n, recentCount: fr[n], historicCount: fh[n], recentRate: rr, historicRate: rh, diff: rr - rh };
    });
    const k = limit || 5;
    return {
      recentDraws: nr,
      historicDraws: nh,
      above: rows.filter(function (r) { return r.diff > 0; }).sort(function (a, b) { return b.diff - a.diff || a.n - b.n; }).slice(0, k),
      below: rows.filter(function (r) { return r.diff < 0; }).sort(function (a, b) { return a.diff - b.diff || a.n - b.n; }).slice(0, k)
    };
  }

  function historyInfo(rawHistory, gameId) {
    const g = getGame(gameId);
    const audit = auditDraws(rawHistory, gameId);
    const limits = [];
    if (!audit.valid) limits.push('Aucun tirage valide disponible.');
    else if (audit.first > g.rulesStart) limits.push('Historique incomplet : les tirages antérieurs au ' + audit.first + ' ne sont pas intégrés.');
    if (audit.invalid.length) limits.push(audit.invalid.length + ' tirage(s) invalide(s) ignoré(s).');
    if (audit.duplicateDates.length) limits.push(audit.duplicateDates.length + ' doublon(s) de date ignoré(s).');
    // Un intervalle inhabituel peut être une vraie pause du calendrier FDJ : il est signalé
    // à part et ne suffit pas à déclarer l'historique incomplet.
    return {
      count: audit.valid - audit.duplicateDates.length, first: audit.first, last: audit.last, rulesStart: g.rulesStart,
      complete: limits.length === 0, limits: limits, calendarIntervals: audit.intervals, audit: audit
    };
  }

  function computeStats(rawHistory, gameId, windowSize, options) {
    const g = getGame(gameId);
    const limit = (options && options.limit) || 10;
    const history = cleanDraws(rawHistory, gameId);
    const win = selectWindow(history, windowSize);
    const bonusHistory = history.filter(function (d) { return d.date >= g.bonusRulesStart; });
    const f = frequencies(win.draws, gameId, 'main');
    const bf = frequencies(win.draws, gameId, 'bonus');
    const gp = gaps(history, gameId, 'main');
    return {
      game: gameId,
      window: { requested: win.requested, analyzed: win.analyzed, first: win.first, last: win.last },
      history: historyInfo(rawHistory, gameId),
      frequencies: { main: f, bonus: bf, mainTotal: sum(f), bonusTotal: sum(bf) },
      historicFrequencies: {
        main: frequencies(history, gameId, 'main'),
        bonus: frequencies(bonusHistory, gameId, 'bonus'),
        mainDraws: history.length,
        bonusDraws: bonusHistory.length,
        bonusSince: bonusHistory.length ? bonusHistory[0].date : null
      },
      gaps: { main: gp, bonus: gaps(history, gameId, 'bonus') },
      hot: rank(f, range(g.mainMax), 'desc', limit),
      cold: rank(f, range(g.mainMax), 'asc', limit),
      late: rank(gp, range(g.mainMax), 'desc', limit),
      bonusRanking: rank(bf, range(g.bonusMax), 'desc', g.bonusMax),
      parity: parityDistribution(win.draws, gameId),
      lowHigh: lowHighDistribution(win.draws, gameId),
      decades: decadeDistribution(win.draws, gameId),
      sums: sumStats(win.draws),
      historicSums: sumStats(history),
      comparison: compareRecentHistoric(win.draws, history, gameId, 'main', 5)
    };
  }

  return {
    GAMES: GAMES,
    getGame: getGame,
    isValidISODate: isValidISODate,
    validateDraw: validateDraw,
    auditDraws: auditDraws,
    cleanDraws: cleanDraws,
    selectWindow: selectWindow,
    frequencies: frequencies,
    gaps: gaps,
    rank: rank,
    percentages: percentages,
    parityDistribution: parityDistribution,
    lowHighDistribution: lowHighDistribution,
    decadeDistribution: decadeDistribution,
    sumStats: sumStats,
    compareRecentHistoric: compareRecentHistoric,
    historyInfo: historyInfo,
    computeStats: computeStats
  };
});
