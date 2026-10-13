'use strict';
// node --test tests/  — aucune requête réseau : la FDJ est simulée.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const src = require('../lib/fdj-source.js');
const { mergeDraws } = require('../lib/fdj-merge.js');
const { createHandler } = require('../api/fdj.js');
const { runUpdate } = require('../scripts/update-fdj.js');

const ROOT = path.join(__dirname, '..');
const TODAY = '2026-10-15';
const NOW = new Date('2026-10-15T08:00:00Z');

function makeZip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  entries.forEach(function (e) {
    const name = Buffer.from(e.name), data = Buffer.from(e.data), comp = zlib.deflateRawSync(data), crc = src.crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(e.badCrc ? crc ^ 1 : crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(e.badCrc ? crc ^ 1 : crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, comp); centrals.push(ch, name);
    offset += 30 + name.length + comp.length;
  });
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat(locals.concat([cd, end]));
}

const repoCsv = {
  loto: src.decodeCsv(fs.readFileSync(path.join(ROOT, 'data/fdj/loto_201911.csv'))),
  euro: src.decodeCsv(fs.readFileSync(path.join(ROOT, 'data/fdj/euromillions_202002.csv')))
};

// Ligne CSV au format exact de l'archive FDJ (mêmes colonnes, même format de date).
function row(gameId, date, day, nums, bonus) {
  const header = repoCsv[gameId].split(/\r?\n/)[0].split(';').map(function (h) { return h.trim(); });
  const cells = repoCsv[gameId].split(/\r?\n/)[1].split(';');
  const sample = cells[header.indexOf('date_de_tirage')].trim();
  const [y, m, d] = date.split('-');
  const set = function (c, v) { cells[header.indexOf(c)] = String(v); };
  set('date_de_tirage', /\//.test(sample) ? d + '/' + m + '/' + y : y + m + d);
  set('jour_de_tirage', day);
  nums.forEach(function (n, i) { set('boule_' + (i + 1), n); });
  if (gameId === 'loto') set('numero_chance', bonus[0]); else { set('etoile_1', bonus[0]); set('etoile_2', bonus[1]); }
  return cells.join(';');
}
function withRows(gameId, rows, opts) {
  const lines = repoCsv[gameId].split(/\r?\n/).filter(Boolean);
  const body = (opts && opts.drop ? lines.slice(1 + opts.drop) : lines.slice(1));
  return [lines[0]].concat(rows, body).join('\n') + '\n';
}
const NEW_LOTO = row('loto', '2026-10-14', 'MERCREDI', [3, 11, 25, 40, 47], [6]);
const NEW_EURO = row('euro', '2026-10-13', 'MARDI', [2, 9, 21, 33, 48], [4, 11]);

function fakeFetch(map) {
  return async function (url, init) {
    const key = Object.keys(src.OFFICIAL).find(function (g) { return src.OFFICIAL[g].url === url; });
    const v = map[key];
    if (typeof v === 'function') return v(init);
    if (v instanceof Error) throw v;
    return { ok: true, status: 200, arrayBuffer: async function () { const b = Buffer.from(v); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); } };
  };
}
const zipOf = function (gameId, csv) { return makeZip([{ name: src.OFFICIAL[gameId].fileName, data: csv }]); };

function tempRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvc-'));
  fs.cpSync(path.join(ROOT, 'data', 'fdj'), path.join(dir, 'data', 'fdj'), { recursive: true });
  ['loto_historique.json', 'euromillions_historique.json', 'data/draws.js'].forEach(function (f) { fs.copyFileSync(path.join(ROOT, f), path.join(dir, f)); });
  return dir;
}
const snapshot = function (dir) { return ['data/draws.js', 'loto_historique.json', 'data/fdj/loto_201911.csv'].map(function (f) { return fs.readFileSync(path.join(dir, f)).toString('base64'); }).join('|'); };
const quiet = function () {};

// --- Lecture des archives ---------------------------------------------------------------

test('les CSV FDJ du dépôt se relisent sans erreur et correspondent à data/draws.js', function () {
  const vm = require('vm'); const ctx = { window: {} }; vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'data/draws.js'), 'utf8'), ctx);
  ['loto', 'euro'].forEach(function (g) {
    const draws = src.parseCsvStrict(repoCsv[g], g);
    const byDate = new Map(ctx.window.LVC_DATA[g].map(function (d) { return [d.date, d]; }));
    draws.forEach(function (d) { const e = byDate.get(d.date); assert.ok(e, g + ' ' + d.date); assert.equal(JSON.stringify([d.nums, d.bonus]), JSON.stringify([e.nums, e.bonus]), g + ' ' + d.date); });
  });
});

test('ZIP : extraction, CRC vérifié, contenu inattendu refusé', function () {
  assert.equal(src.extractZip(zipOf('loto', 'abc'))[0].data.toString(), 'abc');
  assert.throws(function () { src.extractZip(makeZip([{ name: 'x.csv', data: 'abc', badCrc: true }])); }, { code: 'FORMAT' });
  assert.throws(function () { src.extractZip(Buffer.from('<html>maintenance</html>')); }, { code: 'FORMAT' });
  assert.throws(function () { src.csvFromFile(makeZip([{ name: 'a.csv', data: '1' }, { name: 'b.csv', data: '2' }]), 'loto'); }, { code: 'FORMAT' });
});

test('CSV : chaque type d’anomalie bloque le fichier entier', function () {
  const cases = {
    'numéro hors limites': row('loto', '2026-10-14', 'MERCREDI', [3, 11, 25, 40, 50], [6]),
    'numéro répété': row('loto', '2026-10-14', 'MERCREDI', [3, 3, 25, 40, 47], [6]),
    'Chance hors limites': row('loto', '2026-10-14', 'MERCREDI', [3, 11, 25, 40, 47], [11]),
    'jour incohérent': row('loto', '2026-10-14', 'JEUDI', [3, 11, 25, 40, 47], [6]),
    'date illisible': row('loto', '2026-10-14', 'MERCREDI', [3, 11, 25, 40, 47], [6]).replace(/14\/10\/2026|20261014/, '31/02/2026'),
    'date en double': row('loto', '2026-10-12', 'LUNDI', [1, 2, 3, 4, 5], [1])
  };
  Object.keys(cases).forEach(function (k) {
    assert.throws(function () { src.parseCsvStrict(withRows('loto', [cases[k]]), 'loto'); }, { code: 'INVALID' }, k);
  });
  assert.throws(function () { src.parseCsvStrict('date;boule_1\n01/01/2026;4\n', 'loto'); }, { code: 'FORMAT' });
  assert.throws(function () { src.parseCsvStrict('', 'euro'); }, { code: 'FORMAT' });
  assert.throws(function () { src.parseCsvStrict(withRows('euro', [row('euro', '2026-10-13', 'MARDI', [2, 9, 21, 33, 48], [4, 13])]), 'euro'); }, { code: 'INVALID' });
});

// --- Téléchargement ---------------------------------------------------------------------

test('fetchOfficial : réseau coupé, erreur HTTP, page HTML, délai dépassé', async function () {
  await assert.rejects(src.fetchOfficial('loto', { fetchImpl: fakeFetch({ loto: new TypeError('fetch failed') }) }), { code: 'NETWORK' });
  await assert.rejects(src.fetchOfficial('loto', { fetchImpl: fakeFetch({ loto: function () { return { ok: false, status: 503 }; } }) }), { code: 'HTTP' });
  await assert.rejects(src.fetchOfficial('loto', { fetchImpl: fakeFetch({ loto: '<html>Maintenance</html>' }) }), { code: 'FORMAT' });
  await assert.rejects(src.fetchOfficial('loto', { timeoutMs: 50, fetchImpl: fakeFetch({ loto: function () { return new Promise(function () {}); } }) }), { code: 'TIMEOUT' });
  const ok = await src.fetchOfficial('loto', { fetchImpl: fakeFetch({ loto: zipOf('loto', withRows('loto', [NEW_LOTO])) }) });
  assert.equal(ok.draws[ok.draws.length - 1].date, '2026-10-14');
});

// --- Fusion -------------------------------------------------------------------------------

const BASE = [
  { date: '2026-10-07', nums: [1, 2, 3, 4, 5], bonus: [1] },
  { date: '2026-10-10', nums: [6, 7, 8, 9, 10], bonus: [2] },
  { date: '2026-10-12', nums: [11, 12, 13, 14, 15], bonus: [3] }
];
const NEW = { date: '2026-10-14', nums: [3, 11, 25, 40, 47], bonus: [6] };

test('fusion : tirages déjà connus ignorés, nouveau tirage ajouté sans modifier la base', function () {
  const copy = JSON.stringify(BASE);
  const r = mergeDraws(BASE, BASE.concat([NEW]), 'loto', { today: TODAY });
  assert.equal(r.ok, true); assert.equal(r.known, 3); assert.deepEqual(r.added, [NEW]);
  assert.equal(r.merged.length, 4); assert.equal(JSON.stringify(BASE), copy);
  const none = mergeDraws(BASE, BASE, 'loto', { today: TODAY });
  assert.equal(none.ok, true); assert.equal(none.added.length, 0);
});

test('fusion : doublon identique toléré, doublon contradictoire refusé', function () {
  assert.equal(mergeDraws(BASE, [NEW, NEW], 'loto', { today: TODAY }).ok, true);
  const r = mergeDraws(BASE, [NEW, Object.assign({}, NEW, { bonus: [7] })], 'loto', { today: TODAY });
  assert.equal(r.ok, false); assert.equal(r.added.length, 0); assert.equal(r.merged, BASE);
});

test('fusion : tout ou rien face à un conflit, une date future, un jour sans tirage ou un tirage ancien inconnu', function () {
  const bad = {
    'conflit avec la base': { date: '2026-10-12', nums: [11, 12, 13, 14, 16], bonus: [3] },
    'date future': { date: '2026-10-17', nums: [1, 2, 3, 4, 5], bonus: [1] },
    'jeudi': { date: '2026-10-15', nums: [1, 2, 3, 4, 5], bonus: [1] },
    'ancien inconnu': { date: '2026-10-05', nums: [1, 2, 3, 4, 5], bonus: [1] },
    'numéro invalide': { date: '2026-10-14', nums: [0, 2, 3, 4, 5], bonus: [1] }
  };
  Object.keys(bad).forEach(function (k) {
    const r = mergeDraws(BASE, [NEW, bad[k]], 'loto', { today: TODAY });
    assert.equal(r.ok, false, k); assert.equal(r.added.length, 0, k);
  });
  assert.equal(mergeDraws(BASE, null, 'loto', { today: TODAY }).ok, false);
});

test('fusion : un écart de calendrier est signalé sans bloquer', function () {
  const r = mergeDraws(BASE, [{ date: '2026-10-19', nums: [1, 2, 3, 4, 5], bonus: [1] }], 'loto', { today: '2026-10-20' });
  assert.equal(r.ok, true); assert.equal(r.warnings.length, 1);
});

// --- API ----------------------------------------------------------------------------------

function fakeRes() {
  const res = { headers: {}, code: 0, body: null };
  res.setHeader = function (k, v) { res.headers[k.toLowerCase()] = v; };
  res.status = function (c) { res.code = c; return res; };
  res.json = function (b) { res.body = b; return res; };
  return res;
}

test('API : succès → derniers tirages, cache court', async function () {
  const h = createHandler({ now: function () { return NOW; }, fetchImpl: fakeFetch({ loto: zipOf('loto', withRows('loto', [NEW_LOTO])), euro: zipOf('euro', withRows('euro', [NEW_EURO])) }) });
  const res = fakeRes(); await h({ method: 'GET' }, res);
  assert.equal(res.code, 200); assert.equal(res.body.ok, true); assert.equal(res.body.checkedAt, NOW.toISOString());
  assert.equal(res.body.games.loto.last, '2026-10-14'); assert.equal(res.body.games.euro.last, '2026-10-13');
  assert.equal(res.body.games.loto.recent.length, 40);
  assert.match(res.headers['cache-control'], /s-maxage=600/);
});

test('API : un jeu en échec → ok:false, aucun tirage inventé, pas de cache', async function () {
  const h = createHandler({ fetchImpl: fakeFetch({ loto: zipOf('loto', withRows('loto', [NEW_LOTO])), euro: new TypeError('fetch failed') }) });
  const res = fakeRes(); await h({ method: 'GET' }, res);
  assert.equal(res.code, 502); assert.equal(res.body.ok, false);
  assert.equal(res.body.games.loto.ok, true);
  assert.deepEqual(Object.keys(res.body.games.euro).sort(), ['error', 'ok', 'source']);
  assert.equal(res.body.games.euro.error.code, 'NETWORK');
  assert.equal(res.headers['cache-control'], 'no-store');
  const post = fakeRes(); await h({ method: 'POST' }, post); assert.equal(post.code, 405);
});

// --- Script de mise à jour ----------------------------------------------------------------

test('mise à jour : nouveau tirage → sauvegarde, CSV et données régénérées', async function () {
  const dir = tempRoot();
  const r = await runUpdate({ root: dir, now: NOW, log: quiet, fetchImpl: fakeFetch({ loto: zipOf('loto', withRows('loto', [NEW_LOTO])), euro: zipOf('euro', repoCsv.euro) }) });
  assert.equal(r.ok, true); assert.equal(r.written, true);
  assert.equal(r.results[0].status, 'new'); assert.equal(r.results[1].status, 'unchanged');
  assert.ok(fs.existsSync(path.join(r.backupDir, 'data/draws.js')));
  assert.ok(fs.existsSync(path.join(r.backupDir, 'data/fdj/loto_201911.csv')));
  const vm = require('vm'); const ctx = { window: {} }; vm.runInNewContext(fs.readFileSync(path.join(dir, 'data/draws.js'), 'utf8'), ctx);
  const loto = ctx.window.LVC_DATA.loto;
  assert.equal(JSON.stringify(loto[loto.length - 1]), JSON.stringify(NEW));
  const before = { window: {} }; vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'data/draws.js'), 'utf8'), before);
  assert.equal(loto.length, before.window.LVC_DATA.loto.length + 1);
  const log = JSON.parse(fs.readFileSync(path.join(dir, 'data/fdj/derniere-mise-a-jour.json'), 'utf8'));
  assert.equal(log.loto.dernierTirage, '2026-10-14');
});

test('mise à jour : rien de nouveau → aucun fichier touché', async function () {
  const dir = tempRoot(); const before = snapshot(dir);
  const r = await runUpdate({ root: dir, now: NOW, log: quiet, fetchImpl: fakeFetch({ loto: zipOf('loto', repoCsv.loto), euro: zipOf('euro', repoCsv.euro) }) });
  assert.equal(r.ok, true); assert.equal(r.written, false); assert.equal(snapshot(dir), before);
  assert.equal(fs.existsSync(path.join(dir, 'data/sauvegardes')), false);
});

test('mise à jour : réseau coupé, fichier invalide ou tronqué → aucun fichier touché', async function () {
  const scenarios = {
    'réseau coupé': new TypeError('fetch failed'),
    'ligne invalide': zipOf('loto', withRows('loto', [row('loto', '2026-10-14', 'MERCREDI', [3, 11, 25, 40, 99], [6])])),
    'archive tronquée (tirages perdus)': zipOf('loto', withRows('loto', [NEW_LOTO], { drop: 5 })),
    'tirage modifié': zipOf('loto', withRows('loto', [row('loto', '2026-10-12', 'LUNDI', [1, 2, 3, 4, 5], [1])], { drop: 1 })),
    'date future': zipOf('loto', withRows('loto', [row('loto', '2026-10-17', 'SAMEDI', [3, 11, 25, 40, 47], [6])]))
  };
  for (const k of Object.keys(scenarios)) {
    const dir = tempRoot(); const before = snapshot(dir);
    const r = await runUpdate({ root: dir, games: ['loto'], now: NOW, log: quiet, fetchImpl: fakeFetch({ loto: scenarios[k] }) });
    assert.equal(r.ok, false, k); assert.equal(r.written, false, k); assert.equal(snapshot(dir), before, k);
  }
});

test('mise à jour : import manuel d’un fichier (ZIP ou CSV)', async function () {
  const dir = tempRoot();
  const zip = path.join(dir, 'euromillions_202002.zip');
  fs.writeFileSync(zip, zipOf('euro', withRows('euro', [NEW_EURO])));
  const r = await runUpdate({ root: dir, games: ['euro'], file: zip, now: NOW, log: quiet });
  assert.equal(r.ok, true); assert.equal(r.written, true); assert.equal(r.results[0].added[0].date, '2026-10-13');

  const csv = path.join(dir, 'loto.csv');
  fs.writeFileSync(csv, withRows('loto', [NEW_LOTO]));
  const r2 = await runUpdate({ root: dir, games: ['loto'], file: csv, now: NOW, log: quiet, dryRun: true });
  assert.equal(r2.ok, true); assert.equal(r2.written, false); assert.equal(r2.results[0].status, 'new');
  await assert.rejects(runUpdate({ root: dir, file: csv, now: NOW, log: quiet }), /--game/);
});
