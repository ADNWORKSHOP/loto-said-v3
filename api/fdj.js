/*
 * GET /api/fdj — derniers tirages Loto et EuroMillions lus dans les archives officielles FDJ.
 * Aucune clé : les archives sont publiques. La fonction ne stocke rien ; l'application compare
 * les tirages reçus à son historique (lib/fdj-merge.js) avant de les afficher.
 * Un jeu en échec est signalé avec ok:false et aucun tirage : jamais de données de substitution.
 */
'use strict';
const { fetchOfficial, OFFICIAL } = require('../lib/fdj-source.js');

const RECENT_COUNT = 40;
const GAMES = ['loto', 'euro'];

async function readGame(gameId, deps) {
  try {
    const r = await fetchOfficial(gameId, { fetchImpl: deps.fetchImpl, timeoutMs: deps.timeoutMs });
    return {
      ok: true, fileName: r.fileName, source: OFFICIAL[gameId].page,
      count: r.draws.length, first: r.draws[0].date, last: r.draws[r.draws.length - 1].date,
      recent: r.draws.slice(-RECENT_COUNT)
    };
  } catch (e) {
    return { ok: false, source: OFFICIAL[gameId].page, error: { code: e.code || 'ERROR', message: e.message } };
  }
}

function createHandler(deps) {
  const d = deps || {};
  return async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method && req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      res.setHeader('Cache-Control', 'no-store');
      return res.status(405).json({ ok: false, error: { code: 'METHOD', message: 'Méthode non autorisée' } });
    }
    const results = await Promise.all(GAMES.map(function (g) { return readGame(g, d); }));
    const games = {};
    GAMES.forEach(function (g, i) { games[g] = results[i]; });
    const ok = results.every(function (r) { return r.ok; });
    // Succès : cache CDN court (la FDJ publie au plus un tirage par soir). Échec : jamais mis en cache.
    res.setHeader('Cache-Control', ok ? 'public, max-age=0, s-maxage=600, stale-while-revalidate=600' : 'no-store');
    return res.status(ok ? 200 : 502).json({
      ok: ok,
      service: 'Loto Votre Chance - FDJ',
      automatique: true,
      checkedAt: (d.now ? d.now() : new Date()).toISOString(),
      games: games
    });
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
