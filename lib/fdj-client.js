/*
 * Loto Votre Chance — actualisation des résultats depuis /api/fdj (navigateur).
 * À charger après le script principal (utilise DATA, ic, fmt, home, fdj, stats).
 *
 * - Les tirages reçus passent par FdjMerge.mergeDraws : tout ou rien, sans jamais
 *   modifier un tirage déjà connu. En cas de doute, la base intégrée reste affichée.
 * - Le dernier résultat valide est gardé dans ce navigateur (lvc_fdj_v1) pour l'afficher
 *   hors ligne, et il est revalidé à chaque chargement.
 */
(function () {
  'use strict';
  var CACHE_KEY = 'lvc_fdj_v1';
  var AUTO_INTERVAL_MS = 10 * 60 * 1000;
  var TIMEOUT_MS = 25000;
  var NAMES = { loto: 'Loto', euro: 'EuroMillions' };
  var GAMES = ['loto', 'euro'];
  var state = { status: 'idle', message: '', errors: {}, added: { loto: 0, euro: 0 }, lastSuccessAt: null, checkedAt: null };

  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function readCache() { try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null') || { games: {} }; } catch (e) { return { games: {} }; } }
  function writeCache(c) { try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch (e) { /* stockage plein ou désactivé */ } }
  function fmtDateTime(iso) {
    var d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }) + ' à ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  }

  function apply(gameId, recent) {
    var r = window.FdjMerge.mergeDraws(DATA[gameId], recent, gameId);
    if (r.ok) r.added.forEach(function (d) { DATA[gameId].push(d); });
    return r;
  }

  function currentPage() {
    var on = document.querySelector('.nav button.on');
    return on ? on.dataset.page : 'home';
  }

  function render(rerenderPage) {
    var page = currentPage();
    if (rerenderPage && { home: home, fdj: fdj, stats: stats }[page]) { ({ home: home, fdj: fdj, stats: stats })[page](); return; }
    document.querySelectorAll('[data-fdj-status]').forEach(function (el) { el.outerHTML = statusHTML(); });
  }

  function statusHTML() {
    var badge = { idle: 'Base intégrée', loading: 'Actualisation…', ok: 'À jour', partial: 'Partiel', error: 'Non actualisé' }[state.status];
    var cls = state.status === 'ok' ? 'fdj-ok' : state.status === 'error' || state.status === 'partial' ? 'fdj-warn' : '';
    var rows = GAMES.map(function (g) {
      var list = DATA[g] || [];
      var last = list.length ? fmt(list[list.length - 1].date) : 'aucun';
      var err = state.errors[g] ? '<small class="fdj-err">' + esc(state.errors[g]) + '</small>' : '';
      return '<li><span>' + NAMES[g] + '</span><span class="fdj-last"><b>' + last + '</b>' + err + '</span></li>';
    }).join('');
    var success = state.lastSuccessAt ? 'Dernière actualisation réussie : ' + fmtDateTime(state.lastSuccessAt) : 'Aucune actualisation réussie sur cet appareil : affichage de la base intégrée.';
    var msg = state.message ? '<p class="note fdj-msg ' + (state.status === 'ok' ? '' : 'fdj-err') + '">' + esc(state.message) + '</p>' : '';
    var busy = state.status === 'loading';
    return '<section class="card fdj-status" data-fdj-status aria-live="polite" aria-busy="' + busy + '">' +
      '<div class="draw-top"><h2>Résultats officiels FDJ</h2><span class="draw-tag ' + cls + '">' + badge + '</span></div>' +
      '<p class="note">Dernier tirage disponible dans l’application :</p><ul class="fdj-list">' + rows + '</ul>' +
      '<p class="note">' + success + '</p>' + msg +
      '<button class="btn" type="button" onclick="refreshFdj(true)"' + (busy ? ' disabled' : '') + '>' + ic('refresh') + (busy ? 'Actualisation en cours…' : 'Actualiser les résultats') + '</button>' +
      '<p class="note">Source : archives publiques de fdj.fr. Vérifiez toujours vos résultats sur le site officiel FDJ.</p></section>';
  }

  async function refresh(manual) {
    if (state.status === 'loading') return;
    if (location.protocol === 'file:') {
      state.status = 'error'; state.message = 'Actualisation indisponible en ouvrant le fichier directement : utilisez le site en ligne.';
      render(false); return;
    }
    state.status = 'loading'; state.message = ''; render(false);
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
    var addedTotal = 0;
    try {
      var res = await fetch('/api/fdj', { headers: { Accept: 'application/json' }, signal: controller.signal });
      var body = null;
      try { body = await res.json(); } catch (e) { /* réponse non JSON */ }
      if (!body || !body.games) throw new Error(res.status === 404 ? 'service d’actualisation absent de ce site' : 'réponse du serveur illisible (HTTP ' + res.status + ')');

      var cache = readCache(), okCount = 0;
      state.errors = {};
      GAMES.forEach(function (g) {
        var info = body.games[g];
        state.added[g] = 0;
        if (!info || !info.ok) { state.errors[g] = (info && info.error && info.error.message) || 'résultat indisponible'; return; }
        var r = apply(g, info.recent);
        if (!r.ok) { state.errors[g] = 'données FDJ refusées : ' + r.errors.join(' ; '); return; }
        state.added[g] = r.added.length; addedTotal += r.added.length; okCount++;
        cache.games[g] = { recent: info.recent, checkedAt: body.checkedAt };
      });
      state.checkedAt = body.checkedAt;
      if (okCount) { state.lastSuccessAt = cache.lastSuccessAt = new Date().toISOString(); }
      cache.checkedAt = state.checkedAt;
      writeCache(cache);
      state.status = okCount === GAMES.length ? 'ok' : okCount ? 'partial' : 'error';
      state.message = state.status === 'error' ? 'Échec de l’actualisation : la base intégrée reste affichée.'
        : addedTotal ? addedTotal + ' nouveau(x) tirage(s) ajouté(s) et vérifié(s).'
        : manual ? 'Aucun nouveau tirage depuis la dernière actualisation.' : '';
    } catch (e) {
      state.status = 'error';
      state.message = 'Échec de l’actualisation (' + (e.name === 'AbortError' ? 'délai dépassé' : navigator.onLine === false ? 'pas de connexion' : e.message) + '). La base intégrée reste affichée.';
    } finally {
      clearTimeout(timer);
    }
    render(addedTotal > 0);
  }

  function init() {
    var style = document.createElement('style');
    style.textContent = '.fdj-list{list-style:none;margin:8px 0 0;padding:0;display:flex;flex-direction:column;gap:8px}' +
      '.fdj-list li{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:10px 12px;border-radius:12px;background:var(--field);border:1px solid var(--line)}' +
      '.fdj-last{display:flex;flex-direction:column;align-items:flex-end;text-align:right;gap:2px;min-width:0}' +
      '.fdj-err{color:#FB7185;font-size:12px;line-height:1.4}.fdj-ok{color:#4ADE80;border-color:rgba(74,222,128,.4)}.fdj-warn{color:#FBBF24;border-color:rgba(251,191,36,.4)}' +
      '.fdj-status .btn[disabled]{opacity:.6;cursor:progress}';
    document.head.appendChild(style);

    var cache = readCache();
    state.lastSuccessAt = cache.lastSuccessAt || null;
    var added = 0;
    GAMES.forEach(function (g) {
      if (cache.games && cache.games[g] && Array.isArray(cache.games[g].recent)) {
        var r = apply(g, cache.games[g].recent);
        if (r.ok) added += r.added.length; else delete cache.games[g];
      }
    });
    if (added) writeCache(cache);
    // The page rendered before this script loaded, so its status hook was empty.
    render(true);

    var age = cache.checkedAt ? Date.now() - Date.parse(cache.checkedAt) : Infinity;
    if (!(age < AUTO_INTERVAL_MS)) refresh(false);
    else if (state.lastSuccessAt) { state.status = 'ok'; render(false); }
  }

  window.fdjStatusHTML = statusHTML;
  window.refreshFdj = refresh;
  if (window.FdjMerge && typeof DATA !== 'undefined') init();
})();
