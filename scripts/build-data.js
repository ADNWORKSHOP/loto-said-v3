#!/usr/bin/env node
/*
 * Génère toutes les données de tirages à partir des fichiers officiels FDJ (data/fdj/*.csv) :
 *   - loto_historique.json et euromillions_historique.json (archives complètes)
 *   - data/draws.js (historique chargé par index.html)
 * Source : https://www.fdj.fr/jeux-de-tirage/loto/historique et /euromillions-my-million/historique
 * (fichiers téléchargés depuis https://www.sto.api.fdj.fr/anonymous/service-draw-info/v3/documentations/…).
 * Aucune donnée n'est inventée : le script échoue si une ligne est illisible ou invalide.
 *
 * Usage : node scripts/build-data.js [--check]
 *   --check : vérifie que les fichiers générés sont à jour sans les réécrire.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const E = require('../lib/stats-engine.js');

const ROOT = path.join(__dirname, '..');
const FDJ = path.join(ROOT, 'data', 'fdj');

const SOURCES = {
  ancienLoto: ['loto.csv'],
  loto: ['nouveau_loto.csv', 'loto2017.csv', 'loto_201902.csv', 'loto_201911.csv'],
  euro: ['euromillions.csv', 'euromillions_2.csv', 'euromillions_3.csv', 'euromillions_4.csv', 'euromillions_201902.csv', 'euromillions_202002.csv']
};

const DAYS = { LU: 'LUNDI', MA: 'MARDI', ME: 'MERCREDI', JE: 'JEUDI', VE: 'VENDREDI', SA: 'SAMEDI', DI: 'DIMANCHE' };
const WEEKDAYS = ['DIMANCHE', 'LUNDI', 'MARDI', 'MERCREDI', 'JEUDI', 'VENDREDI', 'SAMEDI'];

function readCsv(file) {
  const buf = fs.readFileSync(path.join(FDJ, file));
  const text = buf.toString('utf8').includes('\uFFFD') ? buf.toString('latin1') : buf.toString('utf8');
  const lines = text.split(/\r?\n/).filter(function (l) { return l.trim(); });
  const header = lines[0].split(';').map(function (h) { return h.trim(); });
  return lines.slice(1).map(function (line, i) {
    const cells = line.split(';');
    const row = {};
    header.forEach(function (h, k) { row[h] = (cells[k] || '').trim(); });
    row.__where = file + ':' + (i + 2);
    return row;
  });
}

function toISO(raw, where) {
  let m;
  if ((m = raw.match(/^(\d{4})(\d{2})(\d{2})$/))) return m[1] + '-' + m[2] + '-' + m[3];
  if ((m = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/))) return m[3] + '-' + m[2] + '-' + m[1];
  if ((m = raw.match(/^(\d{2})\/(\d{2})\/(\d{2})$/))) return '20' + m[3] + '-' + m[2] + '-' + m[1];
  throw new Error('Date illisible "' + raw + '" (' + where + ')');
}

function int(raw, where, field) {
  if (!/^\d+$/.test(raw)) throw new Error('Valeur non entière "' + raw + '" pour ' + field + ' (' + where + ')');
  return Number(raw);
}
function sortNum(a) { return a.slice().sort(function (x, y) { return x - y; }); }
function intOrNull(raw) { return /^\d+$/.test(raw || '') ? Number(raw) : null; }
function textOrNull(raw) { return raw ? raw : null; }

function normalizeDay(raw, date, where) {
  const day = DAYS[raw.toUpperCase()] || raw.toUpperCase();
  const real = WEEKDAYS[new Date(date + 'T12:00:00Z').getUTCDay()];
  if (day !== real) throw new Error('Jour "' + raw + '" incohérent avec la date ' + date + ' (' + where + ')');
  return day;
}

function field(row, prefix) {
  const key = Object.keys(row).find(function (k) { return k === prefix; }) || Object.keys(row).find(function (k) { return k.indexOf(prefix) === 0; });
  return key ? row[key] : '';
}

function build() {
  const ancien = [];
  SOURCES.ancienLoto.forEach(function (file) {
    readCsv(file).forEach(function (r) {
      const date = toISO(r.date_de_tirage, r.__where);
      const balls = [1, 2, 3, 4, 5, 6].map(function (i) { return int(r['boule_' + i], r.__where, 'boule_' + i); });
      ancien.push({
        date: date, drawId: r.annee_numero_de_tirage, drawKey: date + '#' + r['1er_ou_2eme_tirage'],
        day: normalizeDay(r.jour_de_tirage, date, r.__where), format: 'ancien_loto_6_numeros',
        balls: balls, chance: null, complementary: int(r.boule_complementaire, r.__where, 'boule_complementaire'),
        drawType: r['1er_ou_2eme_tirage'], joker: intOrNull(r.numero_joker),
        winnersRank1: int(r.nombre_de_gagnant_au_rang1, r.__where, 'gagnants'), prizeRank1: textOrNull(r.rapport_du_rang1),
        source: 'FDJ ' + file
      });
    });
  });

  const loto = [];
  SOURCES.loto.forEach(function (file) {
    readCsv(file).forEach(function (r) {
      const date = toISO(r.date_de_tirage, r.__where);
      loto.push({
        date: date, drawId: r.annee_numero_de_tirage, drawKey: date,
        day: normalizeDay(r.jour_de_tirage, date, r.__where), format: 'loto_5_numeros_chance',
        balls: [1, 2, 3, 4, 5].map(function (i) { return int(r['boule_' + i], r.__where, 'boule_' + i); }),
        chance: int(r.numero_chance, r.__where, 'numero_chance'), complementary: null, drawType: null, joker: null,
        winnersRank1: int(r.nombre_de_gagnant_au_rang1, r.__where, 'gagnants'), prizeRank1: textOrNull(r.rapport_du_rang1),
        source: 'FDJ ' + file
      });
    });
  });

  const euro = [];
  SOURCES.euro.forEach(function (file) {
    readCsv(file).forEach(function (r) {
      const date = toISO(r.date_de_tirage, r.__where);
      euro.push({
        date: date, drawId: r.annee_numero_de_tirage, drawKey: date,
        day: normalizeDay(r.jour_de_tirage, date, r.__where),
        balls: [1, 2, 3, 4, 5].map(function (i) { return int(r['boule_' + i], r.__where, 'boule_' + i); }),
        stars: [int(r.etoile_1, r.__where, 'etoile_1'), int(r.etoile_2, r.__where, 'etoile_2')],
        winnersRank1Europe: intOrNull(field(r, 'nombre_de_gagnant_au_rang1_en_europe') || field(r, 'nombre_de_gagnant_au_rang1_Euro_Millions_en_europe')),
        prizeRank1: textOrNull(field(r, 'rapport_du_rang1')),
        source: 'FDJ ' + file
      });
    });
  });

  const byDate = function (a, b) { return a.drawKey < b.drawKey ? -1 : a.drawKey > b.drawKey ? 1 : 0; };
  ancien.sort(byDate); loto.sort(byDate); euro.sort(byDate);

  const app = {
    loto: loto.map(function (r) { return { date: r.date, nums: sortNum(r.balls), bonus: [r.chance] }; }),
    euro: euro.map(function (r) { return { date: r.date, nums: sortNum(r.balls), bonus: sortNum(r.stars) }; })
  };

  const meta = {};
  ['loto', 'euro'].forEach(function (game) {
    const audit = E.auditDraws(app[game], game);
    if (audit.invalid.length || audit.duplicateDates.length || audit.unsorted.length) {
      throw new Error('Données ' + game + ' invalides : ' + JSON.stringify({ invalid: audit.invalid.slice(0, 5), duplicateDates: audit.duplicateDates.slice(0, 5), unsorted: audit.unsorted.slice(0, 5) }));
    }
    meta[game] = { count: audit.valid, first: audit.first, last: audit.last, sources: SOURCES[game] };
  });

  const drawsJs = '/* Fichier généré par scripts/build-data.js à partir des CSV officiels FDJ (data/fdj). Ne pas modifier à la main. */\n' +
    'window.LVC_DATA_META=' + JSON.stringify(meta) + ';\n' +
    'window.LVC_DATA=' + JSON.stringify(app) + ';\n';

  return {
    files: {
      'loto_historique.json': JSON.stringify(ancien.concat(loto), null, 2) + '\n',
      'euromillions_historique.json': JSON.stringify(euro, null, 2) + '\n',
      'data/draws.js': drawsJs
    },
    meta: meta,
    counts: { ancienLoto: ancien.length, loto: loto.length, euro: euro.length }
  };
}

if (require.main === module) {
  const check = process.argv.includes('--check');
  const out = build();
  let stale = [];
  Object.keys(out.files).forEach(function (rel) {
    const target = path.join(ROOT, rel);
    const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    if (current === out.files[rel]) return;
    if (check) stale.push(rel);
    else fs.writeFileSync(target, out.files[rel]);
  });
  console.log('Ancien Loto : ' + out.counts.ancienLoto + ' tirages');
  ['loto', 'euro'].forEach(function (g) { const m = out.meta[g]; console.log(g + ' : ' + m.count + ' tirages du ' + m.first + ' au ' + m.last); });
  if (check && stale.length) { console.error('Fichiers à régénérer : ' + stale.join(', ')); process.exit(1); }
  console.log(check ? 'Données générées à jour.' : 'Fichiers écrits.');
}

module.exports = { build: build, SOURCES: SOURCES };
