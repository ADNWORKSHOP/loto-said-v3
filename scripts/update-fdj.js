#!/usr/bin/env node
/*
 * Met à jour l'historique intégré (data/fdj/*.csv, data/draws.js, *_historique.json) à partir
 * des archives officielles FDJ.
 *
 * Usage :
 *   node scripts/update-fdj.js                         télécharge Loto et EuroMillions depuis la FDJ
 *   node scripts/update-fdj.js --game loto             un seul jeu (loto | euro)
 *   node scripts/update-fdj.js --game euro --file ~/Téléchargements/euromillions_202002.zip
 *                                                      import manuel d'une archive (.zip ou .csv)
 *                                                      téléchargée sur fdj.fr/…/historique
 *   node scripts/update-fdj.js --dry-run               contrôle sans rien écrire
 *
 * Garanties :
 *   - le fichier reçu est validé en entier (dates, jours, numéros, doublons) ;
 *   - il doit contenir à l'identique tous les tirages déjà connus (aucune perte, aucune réécriture) ;
 *   - une sauvegarde horodatée est créée dans data/sauvegardes/ avant toute écriture ;
 *   - si la régénération échoue, les fichiers d'origine sont restaurés.
 * Code de sortie : 0 succès ou rien à faire, 1 échec, 2 succès partiel.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const src = require('../lib/fdj-source.js');
const { mergeDraws, todayParis } = require('../lib/fdj-merge.js');
const { build } = require('./build-data.js');

const ROOT = path.join(__dirname, '..');
const GENERATED = ['loto_historique.json', 'euromillions_historique.json', 'data/draws.js'];
const LOG_FILE = 'data/fdj/derniere-mise-a-jour.json';

function stamp(date) { return date.toISOString().replace(/[:.]/g, '-').replace('Z', ''); }

async function loadIncoming(gameId, opts) {
  if (opts.file) {
    const file = src.csvFromFile(fs.readFileSync(opts.file), gameId);
    return { origin: 'fichier ' + path.basename(opts.file), fileName: file.fileName, bytes: file.bytes, draws: src.parseCsvStrict(src.decodeCsv(file.bytes), gameId, path.basename(opts.file)) };
  }
  const r = await src.fetchOfficial(gameId, { fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs });
  return { origin: 'FDJ ' + r.url, fileName: r.fileName, bytes: r.bytes, draws: r.draws };
}

async function checkGame(gameId, opts) {
  const result = { game: gameId, status: 'error', added: [], message: '' };
  try {
    const incoming = await loadIncoming(gameId, opts);
    const target = path.join(opts.root, 'data', 'fdj', incoming.fileName);
    const existing = src.parseCsvStrict(src.decodeCsv(fs.readFileSync(target)), gameId, incoming.fileName);
    const received = new Set(incoming.draws.map(function (d) { return d.date; }));
    const lost = existing.filter(function (d) { return !received.has(d.date); });
    if (lost.length) {
      throw new src.FdjError('INVALID', 'le fichier reçu ne contient pas ' + lost.length + ' tirage(s) déjà enregistré(s) (ex. ' + lost[0].date + ') : import refusé pour ne rien perdre');
    }
    const merge = mergeDraws(existing, incoming.draws, gameId, { today: opts.today });
    if (!merge.ok) {
      const detail = merge.conflicts.map(function (c) { return c.date + ' : ' + c.reason; })
        .concat(merge.rejected.map(function (r) { return r.date + ' : ' + r.errors.join(', '); }));
      throw new src.FdjError('INVALID', merge.errors.join(' ; ') + (detail.length ? ' — ' + detail.slice(0, 3).join(' | ') : ''));
    }
    result.added = merge.added;
    result.warnings = merge.warnings;
    result.last = merge.merged[merge.merged.length - 1].date;
    result.origin = incoming.origin;
    result.target = target;
    result.bytes = incoming.bytes;
    result.status = merge.added.length ? 'new' : 'unchanged';
    result.message = merge.added.length
      ? merge.added.length + ' nouveau(x) tirage(s) : ' + merge.added.map(function (d) { return d.date; }).join(', ')
      : 'aucun nouveau tirage (dernier : ' + result.last + ')';
  } catch (e) {
    result.message = (e.code ? '[' + e.code + '] ' : '') + e.message;
  }
  return result;
}

function backup(root, files, now) {
  const dir = path.join(root, 'data', 'sauvegardes', stamp(now));
  files.forEach(function (rel) {
    const from = path.join(root, rel);
    if (!fs.existsSync(from)) return;
    const to = path.join(dir, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  });
  return dir;
}

function restore(root, dir, files) {
  files.forEach(function (rel) {
    const saved = path.join(dir, rel);
    if (fs.existsSync(saved)) fs.copyFileSync(saved, path.join(root, rel));
  });
}

function writeAtomic(file, data) {
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

/**
 * @param {{root?, games?, file?, dryRun?, fetchImpl?, timeoutMs?, now?: Date, log?}} options
 * @returns {Promise<{ok, partial, written, backupDir, results}>}
 */
async function runUpdate(options) {
  const opts = Object.assign({ root: ROOT, games: ['loto', 'euro'], log: console.log }, options || {});
  const now = opts.now || new Date();
  opts.today = opts.today || todayParis(now);
  if (opts.file && opts.games.length !== 1) throw new Error('--file nécessite --game loto ou --game euro');

  const results = [];
  for (const g of opts.games) results.push(await checkGame(g, opts));
  results.forEach(function (r) { opts.log((r.status === 'error' ? 'ÉCHEC ' : 'OK    ') + r.game + ' : ' + r.message); (r.warnings || []).forEach(function (w) { opts.log('      attention : ' + w); }); });

  const toWrite = results.filter(function (r) { return r.status === 'new'; });
  const failed = results.filter(function (r) { return r.status === 'error'; });
  const out = { ok: failed.length === 0, partial: failed.length > 0 && failed.length < results.length, written: false, backupDir: null, results: results };
  if (!toWrite.length || opts.dryRun) {
    if (opts.dryRun && toWrite.length) opts.log('Contrôle seul (--dry-run) : aucun fichier modifié.');
    return out;
  }

  const touched = toWrite.map(function (r) { return path.relative(opts.root, r.target); }).concat(GENERATED, [LOG_FILE]);
  out.backupDir = backup(opts.root, touched, now);
  opts.log('Sauvegarde : ' + path.relative(opts.root, out.backupDir));
  try {
    toWrite.forEach(function (r) { writeAtomic(r.target, r.bytes); });
    const generated = build(opts.root);
    toWrite.forEach(function (r) {
      if (generated.meta[r.game].last !== r.last) throw new Error('après régénération, le dernier tirage ' + r.game + ' est ' + generated.meta[r.game].last + ' au lieu de ' + r.last);
    });
    Object.keys(generated.files).forEach(function (rel) { writeAtomic(path.join(opts.root, rel), generated.files[rel]); });
    const logPath = path.join(opts.root, LOG_FILE);
    const log = fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath, 'utf8')) : {};
    log.derniereMiseAJour = now.toISOString();
    toWrite.forEach(function (r) { log[r.game] = { dernierTirage: r.last, ajoutes: r.added.map(function (d) { return d.date; }), origine: r.origin, le: now.toISOString() }; });
    writeAtomic(logPath, JSON.stringify(log, null, 2) + '\n');
    out.written = true;
    opts.log('Fichiers mis à jour. ' + ['loto', 'euro'].map(function (g) { return g + ' : ' + generated.meta[g].count + ' tirages jusqu’au ' + generated.meta[g].last; }).join(' ; '));
  } catch (e) {
    restore(opts.root, out.backupDir, touched);
    out.ok = false;
    out.partial = false;
    out.error = e.message;
    opts.log('ÉCHEC de l’écriture, fichiers d’origine restaurés : ' + e.message);
  }
  return out;
}

function parseArgs(argv) {
  const a = { games: ['loto', 'euro'] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') a.dryRun = true;
    else if (argv[i] === '--game') a.games = [argv[++i]];
    else if (argv[i] === '--file') a.file = argv[++i];
    else throw new Error('Option inconnue : ' + argv[i]);
  }
  a.games.forEach(function (g) { if (!src.OFFICIAL[g]) throw new Error('Jeu inconnu : ' + g + ' (loto ou euro)'); });
  return a;
}

if (require.main === module) {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(1); }
  runUpdate(args).then(function (r) {
    process.exit(r.ok ? 0 : r.partial && !r.error ? 2 : 1);
  }, function (e) { console.error(e.message); process.exit(1); });
}

module.exports = { runUpdate: runUpdate, checkGame: checkGame };
