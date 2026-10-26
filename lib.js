// Fonctions pures : montants, dates, CSV, catégories par défaut. Aucune dépendance au DOM ni à Firebase.

// ---------- Montants (toujours en centimes entiers) ----------
const EUR = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });
const NUM = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const fmt = (cents) => EUR.format((cents || 0) / 100);
export const fmtNum = (cents) => NUM.format((cents || 0) / 100);

/** "1 234,56 €", "-12,5", "1.234,56", "(15,00)", "12.50" → centimes ; null si illisible. */
export function parseAmount(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[\s  €]/g, '').replace(/^\+/, '');
  if (s.startsWith('-') || s.startsWith('−')) { neg = !neg; s = s.slice(1); }
  if (s.endsWith('-')) { neg = !neg; s = s.slice(0, -1); }
  if (!s) return null;
  const lastComma = s.lastIndexOf(','), lastDot = s.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    // le dernier séparateur est le séparateur décimal
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (lastComma >= 0) {
    const parts = s.split(',');
    s = parts.length > 2 ? parts.join('') : s.replace(',', '.');
  } else if (lastDot >= 0) {
    const parts = s.split('.');
    // "1.234" (3 chiffres après un seul point) = milliers ; sinon décimal
    if (parts.length > 2 || (parts.length === 2 && parts[1].length === 3 && parts[0].length <= 3 && parts[0] !== '0')) s = parts.join('');
  }
  if (!/^\d*\.?\d*$/.test(s) || s === '.') return null;
  const v = Math.round(parseFloat(s) * 100);
  if (!Number.isFinite(v)) return null;
  return neg ? -v : v;
}

/** Saisie au pavé : "12,5" → 1250 */
export function keypadToCents(str) {
  if (!str) return 0;
  return Math.round(parseFloat(str.replace(',', '.')) * 100) || 0;
}

/** Affichage de la saisie en cours : "1234,5" → "1 234,5" */
export function keypadDisplay(str) {
  if (!str) return '0';
  const [i, d] = str.split(',');
  const int = (i || '0').replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return d === undefined ? int : `${int},${d}`;
}

export function keypadPress(str, key) {
  if (key === 'back') return str.slice(0, -1);
  if (key === ',') return str.includes(',') ? str : (str || '0') + ',';
  const [i, d] = str.split(',');
  if (d !== undefined && d.length >= 2) return str;
  if (d === undefined && i.replace(/^0+/, '').length >= 7) return str;
  if (str === '0') return key;
  return str + key;
}

// ---------- Dates ----------
const pad = (n) => String(n).padStart(2, '0');
export const ymOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
export const localISO = (d) => `${ymOf(d)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
export function addMonths(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return ymOf(d);
}
export function monthRange(from, to) {
  const out = [];
  for (let ym = from; ym <= to && out.length < 600; ym = addMonths(ym, 1)) out.push(ym);
  return out;
}
export function ymLabel(ym, style = 'long') {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1, 1);
  if (style === 'short') return d.toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' });
  return d.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
}
export function dayLabel(iso) {
  const d = new Date(iso.slice(0, 10) + 'T12:00');
  return d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

// ---------- Texte ----------
export const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9+]+/g, ' ').trim();
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function slug(s) { return norm(s).replace(/\s+/g, '-').slice(0, 40) || 'x'; }

// ---------- Catégories par défaut ----------
export const PALETTE = ['#4f8cff', '#5ac8fa', '#bf5af2', '#ff375f', '#ff9f0a', '#ffd60a', '#30d158', '#66d4cf', '#ff6482', '#ac8e68', '#0a84ff', '#64d2ff', '#da8fff', '#ff453a', '#a2845e', '#8e8e93'];

const RECURRING_DEFAULT = ['Forfait mobile', 'Netflix', 'Auteuil', 'Prime', 'YouTube Music', 'Mycanal', 'PS Plus'];

export const DEFAULT_GROUPS = [
  { id: 'g-charges', name: 'Charges et abonnements', color: '#4f8cff', cats: ['Loyer + charges courantes', 'Forfait mobile', 'Netflix', 'Auteuil', 'Prime', 'ChatGPT/Grok', 'YouTube Music', 'Voiture', 'Mycanal', 'PS Plus', 'Dépenses voiture', 'Jeux', 'Loisirs', 'Notaire', 'Apple Cloud + Vélib', 'FDM', 'Nourriture midi', 'Cotisations bancaires'] },
  { id: 'g-autres', name: 'Autres', color: '#ff9f0a', cats: ['Algérie', 'Citygo', 'Espèces', 'Impôts', 'Intérêts', 'Appels de fonds', 'Remboursement travaux', 'Travaux'] },
  { id: 'g-epargne', name: 'Épargne et investissement', color: '#30d158', cats: ['CTO', 'Crypto', 'Studio Montgolfier', 'Vidéos IA', 'Trading', 'PEA'] },
];

export function defaultData() {
  const groups = [], cats = [];
  let k = 0;
  DEFAULT_GROUPS.forEach((g, gi) => {
    groups.push({ id: g.id, name: g.name, color: g.color, order: gi * 10, archived: false, budget: null });
    g.cats.forEach((name, ci) => {
      cats.push({
        id: 'c-' + slug(name), name, groupId: g.id, color: PALETTE[k++ % PALETTE.length], order: ci * 10, archived: false, budget: null,
        rec: RECURRING_DEFAULT.includes(name) ? { on: true, amount: null, day: 1 } : { on: false, amount: null, day: 1 },
      });
    });
  });
  return { groups, cats };
}

// ---------- CSV ----------
export function detectDelimiter(text) {
  const first = text.split(/\r?\n/).slice(0, 5).join('\n');
  const count = (c) => (first.match(new RegExp(c === '\t' ? '\t' : '\\' + c, 'g')) || []).length;
  const cands = [';', '\t', ','].map((c) => [c, count(c)]).sort((a, b) => b[1] - a[1]);
  return cands[0][1] > 0 ? cands[0][0] : ';';
}

export function parseCSV(text, delim) {
  text = text.replace(/^﻿/, '');
  delim = delim || detectDelimiter(text);
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const csvCell = (v) => { const s = String(v ?? ''); return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
export const toCSV = (rows) => '﻿' + rows.map((r) => r.map(csvCell).join(';')).join('\r\n') + '\r\n';

const MONTHS = [
  ['janvier', 'janv', 'jan', 'january'], ['fevrier', 'fevr', 'fev', 'feb', 'february'], ['mars', 'mar', 'march'],
  ['avril', 'avr', 'apr', 'april'], ['mai', 'may'], ['juin', 'jun', 'june'], ['juillet', 'juil', 'jul', 'july'],
  ['aout', 'aou', 'aug', 'august'], ['septembre', 'sept', 'sep', 'september'], ['octobre', 'oct', 'october'],
  ['novembre', 'nov', 'november'], ['decembre', 'dec', 'december'],
];
function monthFromWord(w) {
  for (let i = 0; i < 12; i++) if (MONTHS[i].includes(w)) return i + 1;
  return 0;
}
const fullYear = (y) => (y < 100 ? 2000 + y : y);

/** En-tête de colonne → { m, y|null } ou null. Ex. "Octobre 2024", "oct.-24", "10/2024", "2024-10", "01/10/2024", "Novembre". */
export function parseMonthHeader(raw) {
  const s = norm(raw);
  if (!s) return null;
  let r;
  if ((r = s.match(/^(\d{4}) (\d{1,2})$/))) return valid(+r[2], +r[1]);
  if ((r = s.match(/^(\d{1,2}) (\d{1,2}) (\d{2,4})$/))) return valid(+r[2], fullYear(+r[3]));
  if ((r = s.match(/^(\d{1,2}) (\d{2}|\d{4})$/))) return valid(+r[1], fullYear(+r[2]));
  if ((r = s.match(/^([a-z]+)(?: (\d{2}|\d{4}))?$/))) {
    const m = monthFromWord(r[1]);
    if (m) return { m, y: r[2] ? fullYear(+r[2]) : null };
  }
  return null;
  function valid(m, y) { return m >= 1 && m <= 12 && y >= 2000 && y < 2100 ? { m, y } : null; }
}

/**
 * Analyse un export « catégories en lignes, mois en colonnes ».
 * Retourne { months: ['2024-10', ...], rows: [{ name, values: { ym: cents } , kind: 'cat'|'income'|'group' }], skipped: [...] }
 */
export function analyzeSheet(rows, { firstYear = 2024 } = {}) {
  let headerIdx = -1, cols = [];
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const found = [];
    rows[i].forEach((c, j) => { const p = parseMonthHeader(c); if (p) found.push({ j, ...p }); });
    if (found.length >= 2) { headerIdx = i; cols = found; break; }
  }
  if (headerIdx < 0) throw new Error("Impossible de trouver la ligne des mois (ex. « Octobre 2024 », « oct.-24 », « 10/2024 »).");
  // années manquantes : on suit l'ordre chronologique à partir de la précédente
  let prev = null;
  for (const c of cols) {
    if (c.y == null) {
      if (prev) c.y = c.m <= prev.m ? prev.y + 1 : prev.y;
      else c.y = c.m >= 10 ? firstYear : firstYear + 1;
    }
    c.ym = `${c.y}-${String(c.m).padStart(2, '0')}`;
    prev = c;
  }
  const firstMonthCol = Math.min(...cols.map((c) => c.j));
  const out = [], skipped = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    let name = '';
    for (let j = firstMonthCol - 1; j >= 0; j--) if ((r[j] || '').trim()) { name = r[j].trim(); break; }
    if (!name) continue;
    const n = norm(name);
    const values = {}; let any = false;
    for (const c of cols) {
      const v = parseAmount(r[c.j]);
      if (v != null && v !== 0) { values[c.ym] = (values[c.ym] || 0) + v; any = true; }
    }
    if (/^(sous )?total|^reste|^solde|^moyenne|^ecart|^difference/.test(n)) { skipped.push(name); continue; }
    if (/revenu|salaire|^paie|^income/.test(n)) { out.push({ name, values, kind: 'income' }); continue; }
    out.push({ name, values, kind: any ? 'cat' : 'group' });
  }
  return { months: [...new Set(cols.map((c) => c.ym))].sort(), rows: out, skipped };
}

/** Trouve une catégorie par nom (exact puis approché). */
export function matchCategory(name, cats) {
  const n = norm(name);
  if (!n) return null;
  return cats.find((c) => norm(c.name) === n)
    || cats.find((c) => norm(c.name).replace(/ /g, '') === n.replace(/ /g, ''))
    || cats.find((c) => n.length >= 4 && (norm(c.name).startsWith(n) || n.startsWith(norm(c.name))))
    || null;
}

/** Classe la valeur d'un budget : ok (< 80 %), warn (80–100 %), over (> 100 %). */
export function budgetClass(spent, budget) {
  if (!budget || budget <= 0) return '';
  const p = spent / budget;
  return p > 1 ? 'over' : p >= 0.8 ? 'warn' : 'ok';
}
