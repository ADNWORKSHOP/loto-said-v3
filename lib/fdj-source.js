/*
 * Loto Votre Chance — lecture des archives officielles FDJ (Node uniquement).
 *
 * Source vérifiée le 13/10/2026 : les pages
 *   https://www.fdj.fr/jeux-de-tirage/loto/historique
 *   https://www.fdj.fr/jeux-de-tirage/euromillions-my-million/historique
 * proposent des archives ZIP publiques (sans clé) servies par sto.api.fdj.fr. L'archive en cours
 * de chaque jeu est mise à jour par la FDJ après chaque tirage. Ce n'est pas une API documentée :
 * le format est vérifié à chaque lecture et toute anomalie bloque l'import.
 */
'use strict';
const zlib = require('zlib');
const E = require('./stats-engine.js');

const BASE_URL = 'https://www.sto.api.fdj.fr/anonymous/service-draw-info/v3/documentations/';
const OFFICIAL = {
  loto: {
    name: 'Loto', fileName: 'loto_201911.csv', documentId: '1a2b3c4d-9876-4562-b3fc-2c963f66afp6',
    page: 'https://www.fdj.fr/jeux-de-tirage/loto/historique',
    columns: ['date_de_tirage', 'jour_de_tirage', 'boule_1', 'boule_2', 'boule_3', 'boule_4', 'boule_5', 'numero_chance']
  },
  euro: {
    name: 'EuroMillions', fileName: 'euromillions_202002.csv', documentId: '1a2b3c4d-9876-4562-b3fc-2c963f66afe6',
    page: 'https://www.fdj.fr/jeux-de-tirage/euromillions-my-million/historique',
    columns: ['date_de_tirage', 'jour_de_tirage', 'boule_1', 'boule_2', 'boule_3', 'boule_4', 'boule_5', 'etoile_1', 'etoile_2']
  }
};
Object.keys(OFFICIAL).forEach(function (g) { OFFICIAL[g].url = BASE_URL + OFFICIAL[g].documentId; });

const DAYS = { LU: 'LUNDI', MA: 'MARDI', ME: 'MERCREDI', JE: 'JEUDI', VE: 'VENDREDI', SA: 'SAMEDI', DI: 'DIMANCHE' };
const WEEKDAYS = ['DIMANCHE', 'LUNDI', 'MARDI', 'MERCREDI', 'JEUDI', 'VENDREDI', 'SAMEDI'];

class FdjError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'FdjError';
    this.code = code; // NETWORK | TIMEOUT | HTTP | FORMAT | INVALID
    if (details) this.details = details;
  }
}

function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  let c, crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xFF;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xEDB88320 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function isZip(buf) { return Buffer.isBuffer(buf) && buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50; }

// Lecteur ZIP minimal (méthodes 0 et 8, contrôle CRC) : évite toute dépendance externe.
function extractZip(buf) {
  if (!isZip(buf)) throw new FdjError('FORMAT', 'Le fichier reçu n’est pas une archive ZIP');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new FdjError('FORMAT', 'Archive ZIP tronquée (répertoire central introuvable)');
  const total = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = [];
  for (let n = 0; n < total; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new FdjError('FORMAT', 'Archive ZIP corrompue');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new FdjError('FORMAT', 'Archive ZIP corrompue (' + name + ')');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.slice(start, start + compSize);
    let data;
    try {
      if (method === 0) data = Buffer.from(raw);
      else if (method === 8) data = zlib.inflateRawSync(raw);
      else throw new FdjError('FORMAT', 'Méthode de compression ZIP non gérée (' + method + ')');
    } catch (e) {
      if (e instanceof FdjError) throw e;
      throw new FdjError('FORMAT', 'Décompression impossible de ' + name);
    }
    if (crc32(data) !== crc) throw new FdjError('FORMAT', 'Contrôle d’intégrité (CRC) échoué pour ' + name);
    files.push({ name: name, data: data });
  }
  return files;
}

function decodeCsv(buf) {
  const utf8 = buf.toString('utf8');
  return utf8.indexOf('\uFFFD') !== -1 ? buf.toString('latin1') : utf8;
}

function toISO(raw) {
  let m;
  if ((m = raw.match(/^(\d{4})(\d{2})(\d{2})$/))) return m[1] + '-' + m[2] + '-' + m[3];
  if ((m = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/))) return m[3] + '-' + m[2] + '-' + m[1];
  return null;
}

/**
 * Lit un CSV FDJ et renvoie { draws, errors }. Les tirages sont au format de l'application
 * ({ date, nums, bonus } triés). Erreur FORMAT si la structure n'est pas celle attendue.
 */
function parseCsv(text, gameId, source) {
  const cfg = OFFICIAL[gameId];
  if (!cfg) throw new FdjError('FORMAT', 'Jeu inconnu : ' + gameId);
  const label = source || cfg.fileName;
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter(function (l) { return l.trim(); });
  if (lines.length < 2) throw new FdjError('FORMAT', label + ' : fichier vide ou sans tirage');
  const header = lines[0].split(';').map(function (h) { return h.trim(); });
  const missing = cfg.columns.filter(function (c) { return header.indexOf(c) === -1; });
  if (missing.length) throw new FdjError('FORMAT', label + ' : colonnes absentes (' + missing.join(', ') + '). Ce n’est pas un fichier ' + cfg.name + ' FDJ au format actuel.');
  const col = {};
  cfg.columns.forEach(function (c) { col[c] = header.indexOf(c); });

  const draws = [], errors = [], dates = new Map();
  lines.slice(1).forEach(function (line, i) {
    const where = label + ' ligne ' + (i + 2);
    const cells = line.split(';').map(function (c) { return c.trim(); });
    const get = function (c) { return cells[col[c]] || ''; };
    const rowErrors = [];
    const date = toISO(get('date_de_tirage'));
    if (!date) rowErrors.push('date illisible « ' + get('date_de_tirage') + ' »');
    const ints = function (names) {
      return names.map(function (c) {
        const v = get(c);
        if (!/^\d+$/.test(v)) { rowErrors.push(c + ' non numérique « ' + v + ' »'); return NaN; }
        return Number(v);
      });
    };
    const nums = ints(['boule_1', 'boule_2', 'boule_3', 'boule_4', 'boule_5']).sort(function (a, b) { return a - b; });
    const bonus = ints(gameId === 'loto' ? ['numero_chance'] : ['etoile_1', 'etoile_2']).sort(function (a, b) { return a - b; });
    if (date) {
      const dayRaw = get('jour_de_tirage').toUpperCase();
      const day = DAYS[dayRaw] || dayRaw;
      const real = WEEKDAYS[new Date(date + 'T12:00:00Z').getUTCDay()];
      if (day !== real) rowErrors.push('jour « ' + get('jour_de_tirage') + ' » incohérent avec la date ' + date + ' (' + real.toLowerCase() + ')');
    }
    const draw = { date: date, nums: nums, bonus: bonus };
    if (!rowErrors.length) E.validateDraw(draw, gameId).forEach(function (e) { rowErrors.push(e); });
    if (!rowErrors.length && dates.has(date)) rowErrors.push('date ' + date + ' en double (déjà ligne ' + dates.get(date) + ')');
    if (rowErrors.length) { errors.push({ where: where, date: date, errors: rowErrors }); return; }
    dates.set(date, i + 2);
    draws.push(draw);
  });
  draws.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
  return { draws: draws, errors: errors };
}

// Lit un CSV FDJ et refuse le fichier entier à la moindre ligne invalide.
function parseCsvStrict(text, gameId, source) {
  const out = parseCsv(text, gameId, source);
  if (out.errors.length) {
    const first = out.errors[0];
    throw new FdjError('INVALID', out.errors.length + ' ligne(s) invalide(s) — ' + first.where + ' : ' + first.errors.join(', '), out.errors.slice(0, 20));
  }
  return out.draws;
}

// Contenu d'un fichier importé à la main : archive ZIP FDJ ou CSV déjà extrait.
function csvFromFile(buf, gameId) {
  const cfg = OFFICIAL[gameId];
  if (!isZip(buf)) return { fileName: cfg.fileName, bytes: buf };
  const csvs = extractZip(buf).filter(function (f) { return /\.csv$/i.test(f.name); });
  const exact = csvs.find(function (f) { return f.name.split('/').pop() === cfg.fileName; });
  if (exact) return { fileName: cfg.fileName, bytes: exact.data };
  if (csvs.length === 1) return { fileName: cfg.fileName, bytes: csvs[0].data, originalName: csvs[0].name };
  throw new FdjError('FORMAT', 'Archive sans fichier ' + cfg.fileName + ' (contenu : ' + (csvs.map(function (f) { return f.name; }).join(', ') || 'aucun CSV') + ')');
}

/**
 * Télécharge l'archive officielle en cours d'un jeu et la valide intégralement.
 * @returns {Promise<{game, fileName, url, bytes: Buffer, draws: Array}>}
 */
async function fetchOfficial(gameId, opts) {
  const cfg = OFFICIAL[gameId];
  if (!cfg) throw new FdjError('FORMAT', 'Jeu inconnu : ' + gameId);
  const options = opts || {};
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = options.timeoutMs || 15000;
  const controller = new AbortController();
  let timer;
  const timeout = new Promise(function (_, reject) {
    timer = setTimeout(function () {
      controller.abort();
      reject(new FdjError('TIMEOUT', 'La FDJ n’a pas répondu en ' + Math.max(1, Math.round(timeoutMs / 1000)) + ' s'));
    }, timeoutMs);
  });
  timeout.catch(function () {});

  let buf;
  try {
    const res = await Promise.race([
      fetchImpl(cfg.url, { signal: controller.signal, headers: { 'User-Agent': 'LotoVotreChance/1.0 (+import archives FDJ)', Accept: 'application/zip,*/*' } }),
      timeout
    ]);
    if (!res || !res.ok) throw new FdjError('HTTP', 'La FDJ a répondu ' + (res ? res.status : 'sans statut') + ' pour l’archive ' + cfg.name);
    buf = Buffer.from(await Promise.race([res.arrayBuffer(), timeout]));
  } catch (e) {
    if (e instanceof FdjError) throw e;
    throw new FdjError('NETWORK', 'FDJ injoignable (' + (e && e.message ? e.message : 'erreur réseau') + ')');
  } finally {
    clearTimeout(timer);
  }

  if (!isZip(buf)) throw new FdjError('FORMAT', 'La FDJ n’a pas renvoyé une archive ZIP (format du site modifié ?)');
  const file = csvFromFile(buf, gameId);
  const draws = parseCsvStrict(decodeCsv(file.bytes), gameId, file.fileName);
  return { game: gameId, fileName: file.fileName, url: cfg.url, bytes: file.bytes, draws: draws };
}

module.exports = {
  OFFICIAL: OFFICIAL, FdjError: FdjError, isZip: isZip,
  extractZip: extractZip, decodeCsv: decodeCsv, parseCsv: parseCsv, parseCsvStrict: parseCsvStrict,
  csvFromFile: csvFromFile, fetchOfficial: fetchOfficial, crc32: crc32
};
