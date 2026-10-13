/*
 * Loto Votre Chance — intégration contrôlée de nouveaux tirages FDJ.
 * Fonctionne dans le navigateur (window.FdjMerge, après stats-engine.js) et dans Node (require).
 *
 * Règle : tout ou rien. Si un seul tirage reçu est invalide, contradictoire avec la base,
 * dupliqué avec des numéros différents, daté dans le futur ou hors calendrier, aucun tirage
 * n'est ajouté et la base reste inchangée.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./stats-engine.js'));
  else root.FdjMerge = factory(root.StatsEngine);
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

  // Jours de tirage actuels (0 = dimanche) : Loto lundi/mercredi/samedi, EuroMillions mardi/vendredi.
  const DRAW_DAYS = { loto: [1, 3, 6], euro: [2, 5] };
  const DAY_NAMES = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];

  function todayParis(now) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(now || new Date());
    const get = function (t) { return parts.find(function (p) { return p.type === t; }).value; };
    return get('year') + '-' + get('month') + '-' + get('day');
  }

  function weekday(date) { return new Date(date + 'T12:00:00Z').getUTCDay(); }
  function sorted(a) { return Array.isArray(a) ? a.slice().sort(function (x, y) { return x - y; }) : a; }
  function normalize(d) { return { date: d.date, nums: sorted(d.nums), bonus: sorted(d.bonus) }; }
  function sameNumbers(a, b) { return JSON.stringify([a.nums, a.bonus]) === JSON.stringify([b.nums, b.bonus]); }
  function byDate(a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; }

  /**
   * @param {Array} base      historique actuel (ordre chronologique), jamais modifié
   * @param {Array} incoming  tirages reçus de la FDJ
   * @param {string} gameId   'loto' | 'euro'
   * @param {{today?: string}} [opts] date du jour AAAA-MM-JJ (Europe/Paris par défaut)
   */
  function mergeDraws(base, incoming, gameId, opts) {
    E.getGame(gameId);
    const today = (opts && opts.today) || todayParis();
    const report = { ok: false, game: gameId, added: [], known: 0, duplicates: [], conflicts: [], rejected: [], warnings: [], errors: [], merged: base };

    if (!Array.isArray(base)) { report.errors.push('historique de base absent'); return report; }
    if (!Array.isArray(incoming)) { report.errors.push('réponse FDJ sans liste de tirages'); return report; }

    const known = new Map();
    base.forEach(function (d) { known.set(d.date, normalize(d)); });
    const last = base.length ? base[base.length - 1].date : null;
    const seen = new Map();

    incoming.forEach(function (raw) {
      const errors = E.validateDraw(raw, gameId);
      if (errors.length) { report.rejected.push({ date: raw && raw.date, errors: errors }); return; }
      const d = normalize(raw);

      if (seen.has(d.date)) {
        if (sameNumbers(seen.get(d.date), d)) report.duplicates.push(d.date);
        else report.conflicts.push({ date: d.date, reason: 'deux résultats différents reçus pour la même date' });
        return;
      }
      seen.set(d.date, d);

      if (known.has(d.date)) {
        if (sameNumbers(known.get(d.date), d)) report.known++;
        else report.conflicts.push({ date: d.date, reason: 'résultat différent de celui déjà enregistré', stored: known.get(d.date), received: d });
        return;
      }

      const why = [];
      if (d.date > today) why.push('date future (' + d.date + ' > ' + today + ')');
      if (last && d.date < last) why.push('tirage antérieur au ' + last + ' absent de la base (archive incohérente)');
      if (DRAW_DAYS[gameId].indexOf(weekday(d.date)) === -1) why.push('le ' + DAY_NAMES[weekday(d.date)] + ' n’est pas un jour de tirage');
      if (why.length) { report.rejected.push({ date: d.date, errors: why }); return; }
      report.added.push(d);
    });

    report.added.sort(byDate);
    if (report.conflicts.length || report.rejected.length) {
      report.added = [];
      report.errors.push('mise à jour refusée : ' + report.conflicts.length + ' conflit(s), ' + report.rejected.length + ' tirage(s) invalide(s)');
      return report;
    }

    const merged = base.concat(report.added);
    const audit = E.auditDraws(merged, gameId);
    if (audit.invalid.length || audit.duplicateDates.length || audit.unsorted.length) {
      report.added = [];
      report.errors.push('historique fusionné incohérent');
      return report;
    }
    const firstAdded = report.added.length ? report.added[0].date : null;
    audit.intervals.forEach(function (gap) {
      if (firstAdded && gap.to >= firstAdded) report.warnings.push('écart de ' + gap.days + ' jours entre le ' + gap.from + ' et le ' + gap.to + ' (tirage annulé ou manquant ?)');
    });

    report.ok = true;
    report.merged = merged;
    return report;
  }

  return { mergeDraws: mergeDraws, todayParis: todayParis, DRAW_DAYS: DRAW_DAYS };
});
