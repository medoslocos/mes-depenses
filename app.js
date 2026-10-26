import { FIREBASE_CONFIG } from './firebase-config.js';
import * as L from './lib.js';
import { firestoreStore, demoStore, setWriteErrorHandler } from './store.js';

const APP_VERSION = '20261026-231853';
const SDK = 'https://www.gstatic.com/firebasejs/12.0.0/';
const LOCAL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
const DEMO = LOCAL && new URLSearchParams(location.search).has('demo');
const { fmt, fmtNum, esc } = L;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const pad = (n) => String(n).padStart(2, '0');
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

let FB = null; // { A, F, auth, db }

const S = {
  store: null, user: null, ready: false,
  groups: [], cats: [], exps: [], months: {}, pending: 0,
  view: 'add', ym: L.ymOf(new Date()),
  amount: '', neg: false, cat: null, whenTouched: false, chipOrder: null,
  hist: { q: '', cat: '', month: '', limit: 150 },
  tableRange: '12', tableScrolled: false, showArchived: false,
  seeded: false, recDone: new Set(),
};

// ---------- Accès aux données ----------
const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name, 'fr');
const groupById = (id) => S.groups.find((g) => g.id === id);
const catById = (id) => S.cats.find((c) => c.id === id);
const catName = (id) => catById(id)?.name || 'Sans catégorie';
const isActiveCat = (c) => !c.archived && !groupById(c.groupId)?.archived;
const strip = ({ id, _p, ...rest }) => rest;
const nowYM = () => L.ymOf(new Date());

function orderedCats({ archived = false } = {}) {
  const gi = new Map(S.groups.map((g, i) => [g.id, i]));
  return S.cats.filter((c) => archived || isActiveCat(c))
    .sort((a, b) => (gi.get(a.groupId) ?? 99) - (gi.get(b.groupId) ?? 99) || byOrder(a, b));
}
function totals(ym) {
  const byCat = {}; let total = 0;
  for (const e of S.exps) if (e.ym === ym) { byCat[e.cat] = (byCat[e.cat] || 0) + e.amount; total += e.amount; }
  return { byCat, total };
}
function groupTotal(gid, byCat) {
  return S.cats.filter((c) => c.groupId === gid).reduce((s, c) => s + (byCat[c.id] || 0), 0);
}
function overBudgets(ym) {
  const { byCat } = totals(ym); const out = [];
  for (const g of S.groups) if (!g.archived && g.budget > 0) { const sp = groupTotal(g.id, byCat); if (sp > g.budget) out.push({ name: g.name, spent: sp, budget: g.budget }); }
  for (const c of S.cats) if (isActiveCat(c) && c.budget > 0 && (byCat[c.id] || 0) > c.budget) out.push({ name: c.name, spent: byCat[c.id], budget: c.budget });
  return out;
}

// ---------- Démarrage ----------
async function boot() {
  registerSW();
  setWriteErrorHandler((e) => toast(`Échec d'enregistrement : ${e.code || e.message}`, { cls: 'warn' }));
  if (DEMO) { S.user = { email: 'demo@local' }; start(demoStore()); return; }
  try {
    const [{ initializeApp }, A, F] = await Promise.all([
      import(SDK + 'firebase-app.js'), import(SDK + 'firebase-auth.js'), import(SDK + 'firebase-firestore.js'),
    ]);
    const app = initializeApp(FIREBASE_CONFIG);
    const auth = A.getAuth(app);
    auth.languageCode = 'fr';
    const db = F.initializeFirestore(app, { localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }) });
    FB = { A, F, auth, db };
    if (A.isSignInWithEmailLink(auth, location.href)) await completeLink(location.href);
    A.onAuthStateChanged(auth, (user) => {
      if (user) { S.user = user; start(firestoreStore(F, db, user.uid)); }
      else { stop(); showLogin(); }
    });
  } catch (e) {
    console.error(e);
    showLogin();
    loginMsg("Impossible de charger l'app (connexion internet nécessaire au premier lancement).");
  }
}

function start(store) {
  if (S.store) return;
  S.store = store;
  $('#boot').hidden = true; $('#login').hidden = true; $('#app').hidden = false;
  store.subscribe(onData, onDataError);
  go(S.view);
}
function stop() {
  S.store?.stop(); S.store = null; S.ready = false; S.seeded = false;
  $('#app').hidden = true;
}

function onData(st) {
  S.groups = st.groups.slice().sort(byOrder);
  S.cats = st.cats.slice().sort(byOrder);
  S.exps = st.exps; S.months = st.months;
  S.pending = Object.values(st.pendingBy).reduce((a, b) => a + b, 0);
  if (!['groups', 'categories', 'expenses', 'months'].every((c) => st.loaded[c])) return;
  S.ready = true;
  const server = st.fromServer.groups && st.fromServer.categories;
  if (!S.groups.length && !S.cats.length) {
    if (server && !S.seeded) { S.seeded = true; seed(); }
    return scheduleRender();
  }
  if (server || !navigator.onLine) applyRecurring();
  scheduleRender();
}
function onDataError(e) {
  console.error(e);
  if (e.code === 'permission-denied') {
    const email = S.user?.email;
    stop(); showLogin();
    loginMsg(`Le compte ${email || ''} n'a pas accès à cette app.`);
    FB?.A.signOut(FB.auth);
  } else toast(`Erreur de synchronisation : ${e.code || e.message}`, { cls: 'warn' });
}

function seed() {
  const { groups, cats } = L.defaultData();
  S.store.batch([
    ...groups.map((g) => ({ op: 'set', col: 'groups', id: g.id, data: strip(g) })),
    ...cats.map((c) => ({ op: 'set', col: 'categories', id: c.id, data: strip(c) })),
  ]);
}

/** Ajoute les charges récurrentes du mois en cours (une seule fois par catégorie et par mois). */
function applyRecurring() {
  const now = new Date(); const ym = L.ymOf(now);
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const applied = S.months[ym]?.recApplied || [];
  const next = [...applied]; const ops = [];
  for (const c of S.cats) {
    if (!isActiveCat(c) || !c.rec?.on || c.rec.amount == null) continue;
    if (applied.includes(c.id) || S.recDone.has(c.id + ym)) continue;
    const day = Math.min(Math.max(1, c.rec.day || 1), last);
    if (now.getDate() < day) continue;
    S.recDone.add(c.id + ym); next.push(c.id);
    const id = `rec-${c.id}-${ym}`;
    // Déjà présent (charge auto, ou montant importé du Sheet pour ce mois) : pas de doublon
    if (S.exps.some((e) => e.id === id || e.id === `imp-${c.id}-${ym}`)) continue;
    ops.push({ op: 'set', col: 'expenses', id, data: { amount: c.rec.amount, cat: c.id, at: `${ym}-${pad(day)}T08:00`, ym, note: 'Automatique', src: 'rec', created: Date.now() } });
  }
  if (next.length !== applied.length) {
    ops.push({ op: 'merge', col: 'months', id: ym, data: { recApplied: next } });
    S.store.batch(ops);
  }
}

// ---------- Connexion ----------
function showLogin() {
  $('#boot').hidden = true; $('#app').hidden = true; $('#login').hidden = false;
  const saved = localStorage.getItem('emailForSignIn');
  if (saved) $('#login-email').value = saved;
}
const loginMsg = (m) => { $('#login-msg').textContent = m || ''; };
function authError(e) {
  const m = {
    'auth/invalid-email': 'Adresse e-mail invalide.',
    'auth/invalid-action-code': 'Lien expiré ou déjà utilisé : redemande un lien.',
    'auth/expired-action-code': 'Lien expiré : redemande un lien.',
    'auth/network-request-failed': 'Pas de connexion internet.',
    'auth/too-many-requests': 'Trop de tentatives, réessaie dans quelques minutes.',
    'auth/quota-exceeded': "Limite d'envoi d'e-mails atteinte pour aujourd'hui, réessaie demain.",
    'auth/unauthorized-continue-uri': "Domaine non autorisé dans Firebase.",
  };
  return m[e.code] || `Erreur : ${e.code || e.message}`;
}
$('#login-send').onclick = async () => {
  const email = $('#login-email').value.trim();
  if (!/^\S+@\S+\.\S+$/.test(email)) return loginMsg('Adresse e-mail invalide.');
  const btn = $('#login-send'); btn.disabled = true; loginMsg('');
  try {
    await FB.A.sendSignInLinkToEmail(FB.auth, email, { url: location.origin + location.pathname, handleCodeInApp: true });
    localStorage.setItem('emailForSignIn', email);
    $('#login-sent-to').textContent = email;
    $('#login-step1').hidden = true; $('#login-step2').hidden = false;
  } catch (e) { loginMsg(authError(e)); }
  btn.disabled = false;
};
$('#login-back').onclick = () => { $('#login-step1').hidden = false; $('#login-step2').hidden = true; loginMsg(''); };
$('#login-paste').onclick = async () => {
  const btn = $('#login-paste');
  if (btn.disabled) return;
  // Tolère du texte autour du lien et les &amp; d'un copier-coller depuis un mail
  const raw = $('#login-link').value.replace(/&amp;/g, '&');
  const link = (raw.match(/https?:\/\/\S+/) || [raw.trim()])[0];
  if (!link) return loginMsg('Colle d\'abord le lien reçu par e-mail.');
  btn.disabled = true; btn.textContent = 'Connexion…'; loginMsg('');
  await completeLink(link);
  btn.disabled = false; btn.textContent = 'Me connecter';
};
async function completeLink(link) {
  try {
    if (!FB.A.isSignInWithEmailLink(FB.auth, link)) return loginMsg("Ce n'est pas un lien de connexion valide (copie le lien entier du mail).");
    let email = localStorage.getItem('emailForSignIn') || $('#login-email').value.trim() || $('#login-sent-to').textContent.trim();
    if (!email) email = (prompt('Confirme ton adresse e-mail') || '').trim();
    if (!email) return loginMsg("Indique ton adresse e-mail (bouton « Changer d'adresse »), puis recolle le lien.");
    const timeout = new Promise((_, rej) => setTimeout(() => rej({ code: 'timeout' }), 20000));
    await Promise.race([FB.A.signInWithEmailLink(FB.auth, email, link), timeout]);
    localStorage.setItem('emailForSignIn', email);
    if (location.search) history.replaceState(null, '', location.pathname);
    // onAuthStateChanged ouvre l'app ; au cas où il tarde, on l'ouvre directement
    if (FB.auth.currentUser && !S.store) { S.user = FB.auth.currentUser; start(firestoreStore(FB.F, FB.db, FB.auth.currentUser.uid)); }
  } catch (e) {
    console.error(e);
    if (FB.auth.currentUser) return;
    showLogin();
    loginMsg(e.code === 'timeout' ? 'Le serveur ne répond pas (réseau faible ?). Réessaie.' : authError(e));
  }
}

// ---------- Navigation et rendu ----------
function go(view) {
  S.view = view;
  $$('.view').forEach((v) => { v.hidden = v.id !== 'v-' + view; });
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $('#main').scrollTop = 0;
  if (view === 'table') S.tableScrolled = false;
  render();
}
$('#tabs').onclick = (e) => { const b = e.target.closest('button'); if (b) go(b.dataset.view); };
$('#btn-settings').onclick = () => go('settings');
$('#top-month').onclick = () => { S.ym = nowYM(); go('month'); };

let rq = false;
function scheduleRender() { if (rq) return; rq = true; requestAnimationFrame(() => { rq = false; render(); }); }
function render() {
  renderTop();
  if (!S.ready) return;
  ({ add: renderAdd, month: renderMonth, table: renderTable, history: renderHistory, budget: renderBudget, settings: renderSettings })[S.view]();
}

function renderTop() {
  const ym = nowYM();
  const t = S.ready ? totals(ym).total : null;
  const label = L.ymLabel(ym);
  $('#top-month').innerHTML = S.view === 'settings' ? '<b>Réglages</b>'
    : `${cap(label)}${t == null ? '' : ` : <b>${fmt(t)}</b>`}`;
  const sync = $('#sync');
  if (!navigator.onLine) { sync.hidden = false; sync.className = 'sync off'; sync.textContent = S.pending ? `Hors ligne · ${S.pending} en attente` : 'Hors ligne'; }
  else if (S.pending) { sync.hidden = false; sync.className = 'sync'; sync.textContent = `Synchro… ${S.pending}`; }
  else sync.hidden = true;
}
addEventListener('online', scheduleRender);
addEventListener('offline', scheduleRender);

function monthNav(ym) {
  return `<div class="month-nav"><button data-nav="-1" aria-label="Mois précédent">‹</button>
    <span class="label" data-nav="0">${cap(L.ymLabel(ym))}</span>
    <button data-nav="1" aria-label="Mois suivant">›</button></div>`;
}
function bindMonthNav(el) {
  $$('[data-nav]', el).forEach((b) => b.onclick = () => {
    const n = +b.dataset.nav; S.ym = n ? L.addMonths(S.ym, n) : nowYM(); render();
  });
}

// ---------- Saisie rapide ----------
function usageCounts() {
  const since = L.localISO(new Date(Date.now() - 120 * 864e5));
  const n = {};
  for (const e of S.exps) if ((e.src || 'manual') === 'manual' && e.at >= since) n[e.cat] = (n[e.cat] || 0) + 1;
  return n;
}
function renderAdd() {
  renderAmount();
  const cats = orderedCats();
  const key = cats.map((c) => c.id).join();
  if (!S.chipOrder || S.chipOrder.key !== key) {
    const n = usageCounts(); const idx = new Map(cats.map((c, i) => [c.id, i]));
    S.chipOrder = { key, ids: cats.map((c) => c.id).sort((a, b) => (n[b] || 0) - (n[a] || 0) || idx.get(a) - idx.get(b)) };
  }
  $('#chips').innerHTML = S.chipOrder.ids.map((id) => {
    const c = catById(id);
    return `<button class="chip ${S.cat === id ? 'sel' : ''}" data-id="${id}" style="--c:${c.color || '#4f8cff'}">${esc(c.name)}</button>`;
  }).join('') || '<p class="muted">Aucune catégorie : ajoute-en dans Réglages.</p>';
  if (!S.whenTouched) $('#when').value = L.localISO(new Date());
}
function renderAmount() {
  const el = $('#amount');
  el.textContent = `${S.neg ? '−' : ''}${L.keypadDisplay(S.amount)} €`;
  el.classList.toggle('neg', S.neg);
  el.classList.toggle('empty', !S.amount);
  $('#sign').classList.toggle('on', S.neg);
  $('#sign').textContent = S.neg ? 'Gain' : '−/+';
}
$('#keypad').onclick = (e) => {
  const k = e.target.closest('button')?.dataset.k; if (!k) return;
  S.amount = L.keypadPress(S.amount, k); renderAmount();
};
$('#sign').onclick = () => { S.neg = !S.neg; renderAmount(); };
$('#chips').onclick = (e) => {
  const b = e.target.closest('.chip'); if (!b) return;
  S.cat = S.cat === b.dataset.id ? null : b.dataset.id;
  $$('#chips .chip').forEach((x) => x.classList.toggle('sel', x.dataset.id === S.cat));
};
$('#when').onchange = () => { S.whenTouched = true; };
$('#note').onkeydown = (e) => { if (e.key === 'Enter') e.target.blur(); };
$('#add-btn').onclick = addExpense;

function shake(el) { el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake'); }
function addExpense() {
  const cents = L.keypadToCents(S.amount);
  if (!cents) { shake($('#amount')); return toast('Saisis un montant'); }
  if (!S.cat) { shake($('#chips')); return toast('Choisis une catégorie'); }
  const at = $('#when').value || L.localISO(new Date());
  const data = { amount: S.neg ? -cents : cents, cat: S.cat, at, ym: at.slice(0, 7), note: $('#note').value.trim(), src: 'manual', created: Date.now() };
  const id = S.store.newId('expenses');
  S.store.set('expenses', id, data);
  const warn = budgetWarning(data, id);
  S.amount = ''; S.neg = false; S.cat = null; S.whenTouched = false;
  $('#note').value = ''; $('#note').blur();
  renderAdd();
  toast(warn ? `⚠️ ${warn}` : `✓ ${fmt(data.amount)} · ${catName(data.cat)}`, {
    cls: warn ? 'warn' : 'ok', action: 'Annuler', onAction: () => S.store.del('expenses', id),
  });
}
function budgetWarning(data, id) {
  const c = catById(data.cat); const g = groupById(c?.groupId);
  const sum = (pred) => S.exps.filter((e) => e.id !== id && e.ym === data.ym && pred(e)).reduce((s, e) => s + e.amount, 0) + data.amount;
  if (c?.budget > 0) { const sp = sum((e) => e.cat === c.id); if (sp > c.budget) return `Budget ${c.name} dépassé : ${fmt(sp)} / ${fmt(c.budget)}`; }
  if (g?.budget > 0) {
    const ids = new Set(S.cats.filter((x) => x.groupId === g.id).map((x) => x.id));
    const sp = sum((e) => ids.has(e.cat)); if (sp > g.budget) return `Budget ${g.name} dépassé : ${fmt(sp)} / ${fmt(g.budget)}`;
  }
  return '';
}

// ---------- Mois en cours ----------
function renderMonth() {
  const v = $('#v-month');
  if (v.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
  const ym = S.ym; const { byCat, total } = totals(ym);
  const income = S.months[ym]?.income ?? null;
  const rest = (income || 0) - total;
  const alerts = overBudgets(ym);
  const missingRec = S.cats.filter((c) => isActiveCat(c) && c.rec?.on && c.rec.amount == null);
  let h = monthNav(ym);
  h += `<div class="card kpis">
    <div class="kpi"><div class="l">Dépensé</div><div class="v">${fmt(total)}</div></div>
    <div class="kpi"><div class="l">Revenus du mois</div><input class="income-input" id="income" inputmode="decimal" placeholder="Saisir…" value="${income != null ? fmtNum(income) : ''}"></div>
    <div class="kpi wide"><div class="l">Reste à vivre</div><div class="v big" style="color:${income == null ? 'var(--muted)' : rest < 0 ? 'var(--red)' : 'var(--green)'}">${income == null ? 'Saisis tes revenus' : fmt(rest)}</div></div>
  </div>`;
  if (alerts.length) h += `<div class="alert">⚠️ Budget dépassé : ${alerts.map((a) => `<b>${esc(a.name)}</b> (+${fmt(a.spent - a.budget)})`).join(', ')}</div>`;
  if (missingRec.length && ym === nowYM()) h += `<button class="alert" style="width:100%;text-align:left;background:rgba(255,159,10,.1);border-color:rgba(255,159,10,.35);color:#ffd08a" id="go-rec">Abonnements sans montant habituel : ${missingRec.map((c) => esc(c.name)).join(', ')}. Touchez pour les renseigner.</button>`;
  const known = new Set(S.cats.map((c) => c.id));
  const orphan = Object.entries(byCat).filter(([id]) => !known.has(id)).reduce((s, [, v]) => s + v, 0);
  let any = false;
  for (const g of S.groups) {
    const cats = S.cats.filter((c) => c.groupId === g.id && byCat[c.id]);
    const gt = groupTotal(g.id, byCat);
    if (g.archived && !gt) continue;
    if (cats.length) any = true;
    const gb = g.budget > 0 ? budgetLine(gt, g.budget) : '';
    h += `<div class="grp"><div class="grp-h" style="--c:${g.color}"><span class="dot"></span><span class="name">${esc(g.name)}${gb}</span><span class="num">${fmt(gt)}</span></div>
      ${cats.sort((a, b) => byCat[b.id] - byCat[a.id]).map((c) => {
        const val = byCat[c.id];
        const bar = c.budget > 0 ? budgetLine(val, c.budget)
          : `<div class="bar"><i style="width:${total > 0 ? Math.max(2, Math.min(100, val / total * 100)) : 0}%;--c:${c.color}"></i></div>`;
        return `<div class="line btnlike" data-cat="${c.id}" style="--c:${c.color}"><span class="dot"></span><div class="name">${esc(c.name)}${bar}</div><span class="amt ${val < 0 ? 'pos' : ''}">${fmt(val)}</span></div>`;
      }).join('')}</div>`;
  }
  if (orphan) h += `<div class="grp"><div class="grp-h"><span class="name">Sans catégorie</span><span class="num">${fmt(orphan)}</span></div></div>`;
  if (!any && !orphan) h += `<div class="empty-state">Aucune dépense ce mois-ci.</div>`;
  v.innerHTML = h;
  bindMonthNav(v);
  const inc = $('#income', v);
  inc.onchange = () => {
    const val = inc.value.trim() ? L.parseAmount(inc.value) : null;
    if (inc.value.trim() && val == null) return toast('Montant illisible', { cls: 'warn' });
    S.store.merge('months', ym, { income: val });
  };
  inc.onkeydown = (e) => { if (e.key === 'Enter') inc.blur(); };
  inc.onblur = () => setTimeout(scheduleRender, 50);
  $$('[data-cat]', v).forEach((el) => el.onclick = () => { S.hist = { ...S.hist, q: '', cat: el.dataset.cat, month: ym }; go('history'); });
  const gr = $('#go-rec', v); if (gr) gr.onclick = () => { go('settings'); setTimeout(() => $('#rec-section')?.scrollIntoView(), 50); };
}
function budgetLine(spent, budget) {
  const cls = L.budgetClass(spent, budget);
  const pct = Math.max(0, Math.min(100, spent / budget * 100));
  const diff = budget - spent;
  return `<div class="bar ${cls}"><i style="width:${pct}%"></i></div>
    <div class="sub ${cls === 'ok' ? '' : cls}">${fmt(spent)} / ${fmt(budget)} · ${diff >= 0 ? `reste ${fmt(diff)}` : `dépassé de ${fmt(-diff)}`}</div>`;
}

// ---------- Tableau mensuel ----------
function tableMonths() {
  const cur = nowYM();
  const yms = S.exps.map((e) => e.ym).filter(Boolean);
  const min = yms.length ? yms.reduce((a, b) => (a < b ? a : b)) : L.addMonths(cur, -11);
  const max = yms.length ? yms.reduce((a, b) => (a > b ? a : b), cur) : cur;
  const all = L.monthRange(min < '2000-01' ? '2000-01' : min, max);
  const r = S.tableRange;
  if (r === 'all') return all;
  if (r === '12') return L.monthRange(L.addMonths(cur, -11), cur);
  return all.filter((m) => m.startsWith(r));
}
function renderTable() {
  const v = $('#v-table');
  const years = [...new Set(S.exps.map((e) => e.ym?.slice(0, 4)).filter(Boolean))].sort();
  const ranges = [['12', '12 derniers mois'], ...years.map((y) => [y, y]), ['all', 'Tout']];
  const months = tableMonths();
  const agg = {};
  for (const e of S.exps) { (agg[e.cat] ??= {})[e.ym] = (agg[e.cat][e.ym] || 0) + e.amount; }
  const cell = (val, attrs = '', cls = '') => `<td class="${cls} ${val ? '' : 'z'}" ${attrs}>${val ? fmtNum(val) : ''}</td>`;
  const rowSum = (vals) => vals.reduce((a, b) => a + b, 0);
  let body = '';
  const colTot = months.map(() => 0);
  for (const g of S.groups) {
    const cats = S.cats.filter((c) => c.groupId === g.id).sort(byOrder)
      .filter((c) => (!c.archived && !g.archived) || months.some((m) => agg[c.id]?.[m]));
    if (!cats.length) continue;
    const gVals = months.map((m) => cats.reduce((s, c) => s + (agg[c.id]?.[m] || 0), 0));
    const gs = rowSum(gVals);
    body += `<tr class="g"><td style="color:${g.color}">${esc(g.name)}</td>${gVals.map((x) => cell(x)).join('')}${cell(gs, '', 'tot')}${cell(Math.round(gs / months.length), '', 'tot')}</tr>`;
    for (const c of cats) {
      const vals = months.map((m) => agg[c.id]?.[m] || 0);
      vals.forEach((x, i) => { colTot[i] += x; });
      const s = rowSum(vals);
      body += `<tr><td>${esc(c.name)}</td>${vals.map((x, i) => cell(x, `data-cat="${c.id}" data-ym="${months[i]}"`)).join('')}${cell(s, '', 'tot')}${cell(Math.round(s / months.length), '', 'tot')}</tr>`;
    }
  }
  const known = new Set(S.cats.map((c) => c.id));
  const orphanVals = months.map((m) => Object.entries(agg).filter(([id]) => !known.has(id)).reduce((s, [, o]) => s + (o[m] || 0), 0));
  if (orphanVals.some(Boolean)) { orphanVals.forEach((x, i) => { colTot[i] += x; }); body += `<tr><td>Sans catégorie</td>${orphanVals.map((x) => cell(x)).join('')}${cell(rowSum(orphanVals), '', 'tot')}<td></td></tr>`; }
  const inc = months.map((m) => S.months[m]?.income || 0);
  const rest = months.map((m, i) => (S.months[m]?.income != null ? inc[i] - colTot[i] : 0));
  const T = rowSum(colTot), I = rowSum(inc), R = rowSum(rest);
  const n = months.length;
  body += `<tr class="t"><td>Total dépenses</td>${colTot.map((x) => cell(x)).join('')}${cell(T, '', 'tot')}${cell(Math.round(T / n), '', 'tot')}</tr>`;
  body += `<tr class="t"><td>Revenus</td>${inc.map((x) => cell(x)).join('')}${cell(I, '', 'tot')}${cell(Math.round(I / n), '', 'tot')}</tr>`;
  body += `<tr class="t"><td>Reste à vivre</td>${rest.map((x) => cell(x)).join('')}${cell(R, '', 'tot')}${cell(Math.round(R / n), '', 'tot')}</tr>`;
  const prevScroll = $('.tbl-wrap', v);
  const keep = prevScroll && S.tableScrolled ? [prevScroll.scrollLeft, prevScroll.scrollTop] : null;
  v.innerHTML = `<div class="seg">${ranges.map(([k, l]) => `<button data-r="${k}" class="${S.tableRange === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Catégorie</th>${months.map((m) => `<th>${L.ymLabel(m, 'short')}</th>`).join('')}<th>Total</th><th>Moy.</th></tr></thead><tbody>${body}</tbody></table></div>
    <p class="muted small">Touchez une case pour voir le détail. Montants en euros.</p>`;
  const w = $('.tbl-wrap', v);
  if (keep) { w.scrollLeft = keep[0]; w.scrollTop = keep[1]; }
  else { w.scrollLeft = w.scrollWidth; S.tableScrolled = true; }
  $$('[data-r]', v).forEach((b) => b.onclick = () => { S.tableRange = b.dataset.r; S.tableScrolled = false; render(); });
  $('tbody', v).onclick = (e) => {
    const td = e.target.closest('td[data-cat]'); if (!td || td.classList.contains('z')) return;
    S.hist = { ...S.hist, q: '', cat: td.dataset.cat, month: td.dataset.ym }; go('history');
  };
}

// ---------- Historique ----------
function catOptions(selected, { all = false } = {}) {
  let h = all ? '<option value="">Toutes catégories</option>' : '';
  for (const g of S.groups) {
    const cats = S.cats.filter((c) => c.groupId === g.id && (all || isActiveCat(c) || c.id === selected)).sort(byOrder);
    if (!cats.length) continue;
    h += `<optgroup label="${esc(g.name)}">${cats.map((c) => `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>${esc(c.name)}${c.archived ? ' (archivée)' : ''}</option>`).join('')}</optgroup>`;
  }
  return h;
}
function renderHistory() {
  const H = S.hist;
  const q = $('#h-search'); if (document.activeElement !== q) q.value = H.q;
  $('#h-cat').innerHTML = catOptions(H.cat, { all: true });
  $('#h-cat').value = H.cat;
  const yms = [...new Set(S.exps.map((e) => e.ym))].sort().reverse();
  if (H.month && !yms.includes(H.month)) yms.unshift(H.month);
  $('#h-month').innerHTML = `<option value="">Tous les mois</option>${yms.map((m) => `<option value="${m}">${L.ymLabel(m)}</option>`).join('')}`;
  $('#h-month').value = H.month;
  const nq = L.norm(H.q);
  const qa = H.q.replace(/[\s  €]/g, '').replace('.', ',');
  const isNum = /^-?[\d,]+$/.test(qa);
  const list = S.exps.filter((e) => {
    if (H.cat && e.cat !== H.cat) return false;
    if (H.month && e.ym !== H.month) return false;
    if (!nq) return true;
    if (isNum && fmtNum(Math.abs(e.amount)).replace(/[\s  ]/g, '').includes(qa.replace('-', ''))) return true;
    const c = catById(e.cat);
    return L.norm(`${e.note || ''} ${c?.name || ''} ${groupById(c?.groupId)?.name || ''}`).includes(nq);
  }).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : (b.created || 0) - (a.created || 0)));
  const total = list.reduce((s, e) => s + e.amount, 0);
  let h = `<div class="muted small" style="margin:2px 4px 0">${list.length} opération${list.length > 1 ? 's' : ''} · total ${fmt(total)}</div>`;
  let day = '';
  const shown = list.slice(0, H.limit);
  const dayTotals = {};
  for (const e of list) { const d = e.at.slice(0, 10); dayTotals[d] = (dayTotals[d] || 0) + e.amount; }
  for (const e of shown) {
    const d = e.at.slice(0, 10);
    if (d !== day) { day = d; h += `<div class="day-h"><span>${cap(L.dayLabel(e.at))}</span><span class="num">${fmt(dayTotals[d])}</span></div>`; }
    const c = catById(e.cat);
    const time = e.src === 'import' || e.src === 'rec' ? '' : e.at.slice(11, 16);
    h += `<div class="sw" data-id="${e.id}"><div class="sw-actions"><button class="ed">Modifier</button><button class="del">Supprimer</button></div>
      <div class="sw-main" style="--c:${c?.color || '#8a93a5'}"><span class="dot"></span><div class="info"><div class="t1">${esc(c?.name || 'Sans catégorie')}${e._p ? '<span class="pending-dot" title="En attente de synchro"></span>' : ''}</div>
      <div class="t2">${[time, esc(e.note || '')].filter(Boolean).join(' · ') || '&nbsp;'}</div></div><span class="amt ${e.amount < 0 ? 'pos' : ''}">${fmt(e.amount)}</span></div></div>`;
  }
  if (list.length > H.limit) h += `<button class="btn small more" id="h-more">Afficher plus (${list.length - H.limit})</button>`;
  if (!list.length) h += '<div class="empty-state">Aucune dépense trouvée.</div>';
  $('#h-list').innerHTML = h;
  const more = $('#h-more'); if (more) more.onclick = () => { H.limit += 300; renderHistory(); };
}
$('#h-search').oninput = (e) => { S.hist.q = e.target.value; S.hist.limit = 150; renderHistory(); };
$('#h-cat').onchange = (e) => { S.hist.cat = e.target.value; renderHistory(); };
$('#h-month').onchange = (e) => { S.hist.month = e.target.value; renderHistory(); };

// Glissement vers la gauche : révèle Modifier / Supprimer
(() => {
  const list = $('#h-list'); const OPEN = -156; let sw = null; let justSwiped = false;
  const closeAll = (except) => $$('.sw-main.open', list).forEach((m) => { if (m !== except) { m.classList.remove('open'); m.style.transform = ''; } });
  list.addEventListener('touchstart', (e) => {
    const m = e.target.closest('.sw-main'); if (!m) return;
    closeAll(m);
    sw = { m, x0: e.touches[0].clientX, y0: e.touches[0].clientY, base: m.classList.contains('open') ? OPEN : 0, t: 0, lock: null };
  }, { passive: true });
  list.addEventListener('touchmove', (e) => {
    if (!sw) return;
    const dx = e.touches[0].clientX - sw.x0, dy = e.touches[0].clientY - sw.y0;
    if (!sw.lock && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) sw.lock = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    if (sw.lock !== 'x') return;
    e.preventDefault();
    sw.t = Math.min(0, Math.max(OPEN - 40, sw.base + dx));
    sw.m.classList.add('drag'); sw.m.style.transform = `translateX(${sw.t}px)`;
  }, { passive: false });
  list.addEventListener('touchend', () => {
    if (!sw) return;
    const { m } = sw; m.classList.remove('drag');
    if (sw.lock === 'x') {
      const open = sw.t < OPEN / 2.5;
      m.classList.toggle('open', open); m.style.transform = open ? `translateX(${OPEN}px)` : '';
      justSwiped = true; setTimeout(() => { justSwiped = false; }, 350);
    }
    sw = null;
  });
  list.addEventListener('click', (e) => {
    const row = e.target.closest('.sw'); if (!row || justSwiped) return;
    const id = row.dataset.id; const main = $('.sw-main', row);
    if (e.target.closest('.del')) return deleteExpense(id);
    if (e.target.closest('.ed')) return openEdit(id);
    if (main.classList.contains('open')) { main.classList.remove('open'); main.style.transform = ''; return; }
    openEdit(id);
  });
})();

function deleteExpense(id) {
  const e = S.exps.find((x) => x.id === id); if (!e) return;
  S.store.del('expenses', id);
  toast(`Supprimé : ${fmt(e.amount)} · ${catName(e.cat)}`, { action: 'Annuler', onAction: () => S.store.set('expenses', id, strip(e)) });
}
function openEdit(id) {
  const e = S.exps.find((x) => x.id === id); if (!e) return;
  const sh = sheet(`<h3>Modifier la dépense</h3>
    <div class="field"><span>Montant (négatif = gain)</span><div class="field-row"><button class="btn small" id="e-sign">−/+</button><input id="e-amount" inputmode="decimal" value="${fmtNum(e.amount).replace(/[  ]/g, '')}"></div></div>
    <div class="field"><span>Catégorie</span><select id="e-cat">${catOptions(e.cat)}</select></div>
    <div class="field"><span>Date et heure</span><input id="e-at" type="datetime-local" value="${e.at}"></div>
    <div class="field"><span>Note</span><input id="e-note" value="${esc(e.note || '')}" autocomplete="off"></div>
    <div class="actions"><button class="btn danger" id="e-del">Supprimer</button><button class="btn primary" id="e-save">Enregistrer</button></div>`);
  $('#e-sign', sh).onclick = () => { const i = $('#e-amount', sh); i.value = i.value.startsWith('-') ? i.value.slice(1) : '-' + i.value; };
  $('#e-del', sh).onclick = () => { closeSheet(); deleteExpense(id); };
  $('#e-save', sh).onclick = () => {
    const amount = L.parseAmount($('#e-amount', sh).value);
    if (amount == null || amount === 0) return shake($('#e-amount', sh));
    const at = $('#e-at', sh).value || e.at;
    S.store.set('expenses', id, { ...strip(e), amount, cat: $('#e-cat', sh).value, at, ym: at.slice(0, 7), note: $('#e-note', sh).value.trim() });
    closeSheet(); toast('Modifié', { cls: 'ok' });
  };
}

// ---------- Budget ----------
function renderBudget() {
  const v = $('#v-budget'); const ym = S.ym; const { byCat } = totals(ym);
  const line = (kind, item, spent) => {
    const b = item.budget > 0 ? item.budget : null;
    return `<div class="line btnlike" data-kind="${kind}" data-id="${item.id}" style="--c:${item.color}">
      <span class="dot"></span><div class="name">${esc(item.name)}${b ? budgetLine(spent, b) : `<div class="sub">${fmt(spent)} · pas de plafond</div>`}</div>
      <span class="amt muted">${b ? '' : '＋'}</span></div>`;
  };
  const all = [...S.groups.filter((g) => !g.archived && g.budget > 0).map((g) => [groupTotal(g.id, byCat), g.budget]),
    ...S.cats.filter((c) => isActiveCat(c) && c.budget > 0).map((c) => [byCat[c.id] || 0, c.budget])];
  const over = all.filter(([s, b]) => s > b).length, warn = all.filter(([s, b]) => L.budgetClass(s, b) === 'warn').length;
  let h = monthNav(ym);
  h += `<div class="card"><div class="kpis"><div class="kpi"><div class="l">Plafonds suivis</div><div class="v">${all.length}</div></div>
    <div class="kpi"><div class="l">Dépassés / proches</div><div class="v"><span style="color:var(--red)">${over}</span> / <span style="color:var(--orange)">${warn}</span></div></div></div>
    <p class="muted small" style="margin:10px 0 0">Touchez un groupe ou une catégorie pour fixer son plafond mensuel. Vert &lt; 80 %, orange 80–100 %, rouge au-delà.</p></div>`;
  for (const g of S.groups.filter((x) => !x.archived)) {
    const cats = S.cats.filter((c) => c.groupId === g.id && isActiveCat(c)).sort((a, b) => (b.budget > 0) - (a.budget > 0) || byOrder(a, b));
    h += `<div class="grp"><div style="font-weight:650">${line('group', g, groupTotal(g.id, byCat))}</div>${cats.map((c) => line('cat', c, byCat[c.id] || 0)).join('')}</div>`;
  }
  v.innerHTML = h;
  bindMonthNav(v);
  $$('[data-kind]', v).forEach((el) => el.onclick = async () => {
    const isG = el.dataset.kind === 'group'; const item = isG ? groupById(el.dataset.id) : catById(el.dataset.id);
    const val = await askAmount(`Plafond mensuel — ${item.name}`, item.budget);
    if (val === undefined) return;
    S.store.merge(isG ? 'groups' : 'categories', item.id, { budget: val });
  });
}

// ---------- Réglages ----------
function renderSettings() {
  const v = $('#v-settings');
  const recTag = (c) => (c.rec?.on ? `<span class="tag ${c.rec.amount == null ? 'warn' : ''}">${c.rec.amount == null ? 'montant ?' : '↻ ' + fmt(c.rec.amount)}</span>` : '');
  let h = '<div class="h2">Catégories et groupes</div>';
  const groups = S.groups.filter((g) => !g.archived);
  for (const g of groups) {
    const cats = S.cats.filter((c) => c.groupId === g.id && !c.archived).sort(byOrder);
    h += `<div class="set-grp"><div class="set-row head"><span class="swatch" style="--c:${g.color}"></span><span class="name">${esc(g.name)}</span>
      <button class="mini" data-act="g-up" data-id="${g.id}" aria-label="Monter">↑</button><button class="mini" data-act="g-down" data-id="${g.id}" aria-label="Descendre">↓</button><button class="mini" data-act="g-edit" data-id="${g.id}" aria-label="Modifier">✎</button></div>
      ${cats.map((c) => `<div class="set-row"><span class="swatch" style="--c:${c.color}"></span><span class="name">${esc(c.name)}</span>${recTag(c)}
        <button class="mini" data-act="c-up" data-id="${c.id}" aria-label="Monter">↑</button><button class="mini" data-act="c-down" data-id="${c.id}" aria-label="Descendre">↓</button><button class="mini" data-act="c-edit" data-id="${c.id}" aria-label="Modifier">✎</button></div>`).join('')}
      <div class="set-row"><button class="btn small" data-act="c-add" data-id="${g.id}">＋ Catégorie</button></div></div>`;
  }
  h += `<button class="btn" data-act="g-add" style="width:100%">＋ Nouveau groupe</button>`;
  const archG = S.groups.filter((g) => g.archived), archC = S.cats.filter((c) => c.archived);
  if (archG.length + archC.length) {
    h += `<button class="btn ghost" data-act="toggle-arch" style="width:100%;margin-top:8px">${S.showArchived ? 'Masquer' : 'Voir'} les éléments archivés (${archG.length + archC.length})</button>`;
    if (S.showArchived) {
      h += `<div class="set-grp">${[...archG.map((g) => ['g', g]), ...archC.map((c) => ['c', c])].map(([k, x]) => `<div class="set-row"><span class="swatch" style="--c:${x.color}"></span>
        <span class="name">${esc(x.name)} <span class="muted small">${k === 'g' ? 'groupe' : esc(groupById(x.groupId)?.name || '')}</span></span>
        <button class="btn small" data-act="${k}-restore" data-id="${x.id}">Restaurer</button></div>`).join('')}</div>`;
    }
  }
  const rec = orderedCats().filter((c) => c.rec?.on);
  h += `<div class="h2" id="rec-section">Charges récurrentes</div><div class="set-grp">
    <div class="set-row"><span class="muted small" style="white-space:normal">Ajoutées automatiquement chaque mois au jour choisi, avec leur montant habituel (modifiable ensuite dans l'historique).</span></div>
    ${rec.map((c) => `<div class="set-row"><span class="swatch" style="--c:${c.color}"></span><span class="name">${esc(c.name)}</span>
      <span class="tag ${c.rec.amount == null ? 'warn' : ''}">${c.rec.amount == null ? 'montant à définir' : `${fmt(c.rec.amount)} · le ${c.rec.day || 1}`}</span>
      <button class="mini" data-act="c-edit" data-id="${c.id}" aria-label="Modifier">✎</button></div>`).join('')}
    <div class="set-row"><span class="muted small" style="white-space:normal">Pour rendre une autre catégorie récurrente : ✎ sur la catégorie.</span></div></div>`;
  h += `<div class="h2">Données</div><div class="list-btns">
    <button class="btn" data-act="import">⬆︎ Importer mon historique (CSV)</button>
    <button class="btn" data-act="export-table">⬇︎ Exporter le tableau mensuel (CSV)</button>
    <button class="btn" data-act="export-all">⬇︎ Exporter toutes les dépenses (CSV)</button></div>
    <p class="muted small">Import : export CSV de ton Google Sheets (Fichier › Télécharger › CSV), catégories en lignes et mois en colonnes (« Octobre 2024 », « oct.-24 », « 10/2024 »…). Les catégories inconnues sont créées ; réimporter remplace l'import précédent des mêmes mois.</p>`;
  h += `<div class="h2">Compte</div><div class="set-grp"><div class="set-row"><span class="name">${esc(S.user?.email || '')}</span><button class="btn small danger" data-act="logout">Se déconnecter</button></div></div>
    <p class="muted small" style="text-align:center">Mes dépenses · version ${APP_VERSION}</p>`;
  v.innerHTML = h;
}
$('#v-settings').onclick = async (e) => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const id = b.dataset.id;
  const sibCats = (c) => S.cats.filter((x) => x.groupId === c.groupId && !x.archived).sort(byOrder);
  const activeGroups = () => S.groups.filter((g) => !g.archived);
  switch (b.dataset.act) {
    case 'g-up': case 'g-down': return move('groups', activeGroups(), id, b.dataset.act.endsWith('up') ? -1 : 1);
    case 'c-up': case 'c-down': return move('categories', sibCats(catById(id)), id, b.dataset.act.endsWith('up') ? -1 : 1);
    case 'g-edit': return openGroupSheet(groupById(id));
    case 'g-add': return openGroupSheet(null);
    case 'c-edit': return openCatSheet(catById(id));
    case 'c-add': return openCatSheet(null, id);
    case 'g-restore': return S.store.merge('groups', id, { archived: false });
    case 'c-restore': return S.store.merge('categories', id, { archived: false });
    case 'toggle-arch': S.showArchived = !S.showArchived; return renderSettings();
    case 'import': return $('#file-import').click();
    case 'export-table': return exportTable();
    case 'export-all': return exportAll();
    case 'logout':
      if (!confirm('Se déconnecter ? Il faudra redemander un lien par e-mail.')) return;
      if (DEMO) return location.reload();
      stop(); await FB.A.signOut(FB.auth); return;
  }
};
function move(col, list, id, dir) {
  const i = list.findIndex((x) => x.id === id); const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  const arr = list.slice(); [arr[i], arr[j]] = [arr[j], arr[i]];
  S.store.batch(arr.map((x, k) => ({ op: 'merge', col, id: x.id, data: { order: k * 10 } })));
}
function nextOrder(list) { return list.reduce((m, x) => Math.max(m, x.order ?? 0), -10) + 10; }

function openGroupSheet(g) {
  const isNew = !g;
  g ||= { name: '', color: L.PALETTE[S.groups.length % L.PALETTE.length], budget: null };
  const sh = sheet(`<h3>${isNew ? 'Nouveau groupe' : 'Modifier le groupe'}</h3>
    <div class="field"><span>Nom</span><input id="g-name" value="${esc(g.name)}" autocomplete="off"></div>
    <div class="field"><span>Couleur</span><input id="g-color" type="color" value="${g.color}"></div>
    <div class="field"><span>Plafond mensuel du groupe (facultatif)</span><input id="g-budget" inputmode="decimal" placeholder="Aucun" value="${g.budget ? fmtNum(g.budget).replace(/[  ]/g, '') : ''}"></div>
    <div class="actions">${isNew ? '' : `<button class="btn danger" id="g-arch">${g.archived ? 'Restaurer' : 'Archiver'}</button>`}<button class="btn primary" id="g-save">Enregistrer</button></div>`);
  $('#g-save', sh).onclick = () => {
    const name = $('#g-name', sh).value.trim(); if (!name) return shake($('#g-name', sh));
    const bv = $('#g-budget', sh).value.trim(); const budget = bv ? L.parseAmount(bv) : null;
    if (bv && budget == null) return shake($('#g-budget', sh));
    const data = { name, color: $('#g-color', sh).value, budget };
    if (isNew) S.store.set('groups', S.store.newId('groups'), { ...data, order: nextOrder(S.groups), archived: false });
    else S.store.merge('groups', g.id, data);
    closeSheet();
  };
  const ar = $('#g-arch', sh);
  if (ar) ar.onclick = () => { S.store.merge('groups', g.id, { archived: !g.archived }); closeSheet(); toast(g.archived ? 'Groupe restauré' : 'Groupe archivé (ses catégories sont masquées)'); };
}
function openCatSheet(c, groupId) {
  const isNew = !c;
  c ||= { name: '', groupId, color: L.PALETTE[S.cats.length % L.PALETTE.length], budget: null, rec: { on: false, amount: null, day: 1 } };
  const rec = c.rec || { on: false, amount: null, day: 1 };
  const money = (x) => (x != null ? fmtNum(x).replace(/[  ]/g, '') : '');
  const sh = sheet(`<h3>${isNew ? 'Nouvelle catégorie' : 'Modifier la catégorie'}</h3>
    <div class="field"><span>Nom</span><input id="c-name" value="${esc(c.name)}" autocomplete="off"></div>
    <div class="field-row" style="margin-bottom:12px"><div class="field" style="flex:1;margin:0"><span>Groupe</span><select id="c-group">${S.groups.filter((g) => !g.archived || g.id === c.groupId).map((g) => `<option value="${g.id}" ${g.id === c.groupId ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select></div>
      <div class="field" style="margin:0"><span>Couleur</span><input id="c-color" type="color" value="${c.color}"></div></div>
    <div class="field"><span>Plafond mensuel (facultatif)</span><input id="c-budget" inputmode="decimal" placeholder="Aucun" value="${money(c.budget)}"></div>
    <label class="check"><input type="checkbox" id="c-rec" ${rec.on ? 'checked' : ''}> Charge récurrente (ajoutée chaque mois)</label>
    <div class="field-row" id="c-rec-f" style="margin-bottom:12px" ${rec.on ? '' : 'hidden'}>
      <div class="field" style="flex:1;margin:0"><span>Montant habituel</span><input id="c-rec-amount" inputmode="decimal" placeholder="ex. 13,49" value="${money(rec.amount)}"></div>
      <div class="field" style="width:90px;margin:0"><span>Jour</span><input id="c-rec-day" inputmode="numeric" value="${rec.day || 1}"></div></div>
    <div class="actions">${isNew ? '' : `<button class="btn danger" id="c-arch">${c.archived ? 'Restaurer' : 'Archiver'}</button>`}<button class="btn primary" id="c-save">Enregistrer</button></div>`);
  $('#c-rec', sh).onchange = (e) => { $('#c-rec-f', sh).hidden = !e.target.checked; };
  $('#c-save', sh).onclick = () => {
    const name = $('#c-name', sh).value.trim(); if (!name) return shake($('#c-name', sh));
    const bv = $('#c-budget', sh).value.trim(); const budget = bv ? L.parseAmount(bv) : null;
    if (bv && budget == null) return shake($('#c-budget', sh));
    const on = $('#c-rec', sh).checked;
    const av = $('#c-rec-amount', sh).value.trim(); const amount = av ? L.parseAmount(av) : null;
    if (on && av && amount == null) return shake($('#c-rec-amount', sh));
    const day = Math.min(31, Math.max(1, parseInt($('#c-rec-day', sh).value, 10) || 1));
    const gid = $('#c-group', sh).value;
    const data = { name, groupId: gid, color: $('#c-color', sh).value, budget, rec: { on, amount, day } };
    if (isNew) S.store.set('categories', S.store.newId('categories'), { ...data, order: nextOrder(S.cats.filter((x) => x.groupId === gid)), archived: false });
    else S.store.merge('categories', c.id, gid !== c.groupId ? { ...data, order: nextOrder(S.cats.filter((x) => x.groupId === gid)) } : data);
    closeSheet();
    if (on && amount != null) setTimeout(applyRecurring, 300);
  };
  const ar = $('#c-arch', sh);
  if (ar) ar.onclick = () => { S.store.merge('categories', c.id, { archived: !c.archived }); closeSheet(); toast(c.archived ? 'Catégorie restaurée' : 'Catégorie archivée (historique conservé)'); };
}

// ---------- Import / export CSV ----------
$('#file-import').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  let text = await f.text();
  if (text.includes('�')) text = new TextDecoder('windows-1252').decode(await f.arrayBuffer());
  try { previewImport(L.analyzeSheet(L.parseCSV(text))); }
  catch (err) { toast(err.message, { cls: 'warn', ms: 6000 }); }
};
function previewImport(an) {
  let ctx = null; const newCats = []; const sums = new Map(); const income = {};
  const pool = S.cats.slice();
  let otherGroup = S.groups.find((g) => L.norm(g.name) === 'autres') || S.groups[0];
  for (const r of an.rows) {
    const asGroup = S.groups.find((g) => L.norm(g.name) === L.norm(r.name));
    if (asGroup) { ctx = asGroup; if (r.kind === 'cat') an.skipped.push(`${r.name} (sous-total du groupe)`); continue; }
    if (r.kind === 'group') continue;
    if (r.kind === 'income') { for (const [m, v] of Object.entries(r.values)) income[m] = (income[m] || 0) + v; continue; }
    let c = L.matchCategory(r.name, pool);
    if (!c) {
      const g = ctx || otherGroup;
      c = { id: S.store.newId('categories'), name: r.name, groupId: g.id, color: L.PALETTE[(S.cats.length + newCats.length) % L.PALETTE.length], order: 1000 + newCats.length * 10, archived: false, budget: null, rec: { on: false, amount: null, day: 1 } };
      newCats.push(c); pool.push(c);
    }
    for (const [m, v] of Object.entries(r.values)) sums.set(`${c.id}|${m}`, (sums.get(`${c.id}|${m}`) || 0) + v);
  }
  const total = [...sums.values()].reduce((a, b) => a + b, 0);
  const months = an.months;
  const curIncluded = months.includes(nowYM());
  const sh = sheet(`<h3>Importer l'historique</h3>
    <div class="preview">
      <b>${months.length} mois</b> (${L.ymLabel(months[0])} → ${L.ymLabel(months[months.length - 1])})<br>
      <b>${sums.size}</b> montants pour un total de <b>${fmt(total)}</b><br>
      ${Object.keys(income).length ? `Revenus trouvés sur <b>${Object.keys(income).length}</b> mois<br>` : ''}
      ${newCats.length ? `Nouvelles catégories (${newCats.length}) :<ul>${newCats.map((c) => `<li>${esc(c.name)} <span class="muted">→ ${esc(groupById(c.groupId)?.name || '')}</span></li>`).join('')}</ul>` : 'Toutes les catégories sont reconnues.'}
      ${an.skipped.length ? `<div class="muted small" style="margin-top:6px">Lignes ignorées : ${an.skipped.map(esc).join(', ')}</div>` : ''}
    </div>
    <p class="muted small">Chaque montant devient une dépense datée du 1er du mois (note « Import Sheets »). Un import précédent des mêmes mois est remplacé.${curIncluded ? ' <b>Le mois en cours est inclus :</b> attention aux doublons avec ce que tu as déjà saisi dans l\'app.' : ''}</p>
    <div class="actions"><button class="btn" id="i-cancel">Annuler</button><button class="btn primary" id="i-go">Importer</button></div>`);
  $('#i-cancel', sh).onclick = closeSheet;
  $('#i-go', sh).onclick = () => {
    const ops = [];
    const keep = new Set();
    for (const c of newCats) ops.push({ op: 'set', col: 'categories', id: c.id, data: strip(c) });
    for (const [k, v] of sums) {
      const [cid, m] = k.split('|'); const id = `imp-${cid}-${m}`; keep.add(id);
      ops.push({ op: 'set', col: 'expenses', id, data: { amount: v, cat: cid, at: `${m}-01T12:00`, ym: m, note: 'Import Sheets', src: 'import', created: Date.now() } });
    }
    for (const e of S.exps) if (e.src === 'import' && months.includes(e.ym) && !keep.has(e.id)) ops.push({ op: 'delete', col: 'expenses', id: e.id });
    // Une charge auto déjà ajoutée est remplacée par le montant importé du même mois
    for (const e of S.exps) if (e.src === 'rec' && keep.has(`imp-${e.cat}-${e.ym}`)) ops.push({ op: 'delete', col: 'expenses', id: e.id });
    for (const [m, v] of Object.entries(income)) ops.push({ op: 'merge', col: 'months', id: m, data: { income: v } });
    // Montant habituel des abonnements : dernière valeur connue
    for (const c of S.cats) {
      if (!c.rec?.on || c.rec.amount != null) continue;
      const last = [...months].reverse().find((m) => sums.get(`${c.id}|${m}`));
      if (last) ops.push({ op: 'merge', col: 'categories', id: c.id, data: { rec: { ...c.rec, amount: sums.get(`${c.id}|${last}`) } } });
    }
    S.store.batch(ops);
    closeSheet();
    toast(`Import terminé : ${sums.size} montants`, { cls: 'ok' });
  };
}
const csvMoney = (c) => (c ? (c / 100).toFixed(2).replace('.', ',') : '');
function exportTable() {
  const yms = S.exps.map((e) => e.ym);
  if (!yms.length) return toast('Aucune donnée à exporter');
  const months = L.monthRange(yms.reduce((a, b) => (a < b ? a : b)), yms.reduce((a, b) => (a > b ? a : b)));
  const agg = {}; for (const e of S.exps) (agg[e.cat] ??= {})[e.ym] = (agg[e.cat][e.ym] || 0) + e.amount;
  const rows = [['Catégorie', ...months.map((m) => L.ymLabel(m)), 'Total']];
  const tot = months.map(() => 0);
  for (const g of S.groups) {
    const cats = S.cats.filter((c) => c.groupId === g.id).sort(byOrder).filter((c) => !c.archived || agg[c.id]);
    if (!cats.length) continue;
    rows.push([g.name]);
    const gv = months.map(() => 0);
    for (const c of cats) {
      const vals = months.map((m) => agg[c.id]?.[m] || 0);
      vals.forEach((x, i) => { gv[i] += x; tot[i] += x; });
      rows.push([c.name, ...vals.map(csvMoney), csvMoney(vals.reduce((a, b) => a + b, 0))]);
    }
    rows.push([`Total ${g.name}`, ...gv.map(csvMoney), csvMoney(gv.reduce((a, b) => a + b, 0))]);
  }
  rows.push([]);
  rows.push(['Total dépenses', ...tot.map(csvMoney), csvMoney(tot.reduce((a, b) => a + b, 0))]);
  rows.push(['Revenus', ...months.map((m) => csvMoney(S.months[m]?.income || 0))]);
  rows.push(['Reste à vivre', ...months.map((m, i) => (S.months[m]?.income != null ? csvMoney(S.months[m].income - tot[i]) : ''))]);
  saveFile(`depenses-tableau-${nowYM()}.csv`, L.toCSV(rows));
}
function exportAll() {
  if (!S.exps.length) return toast('Aucune donnée à exporter');
  const rows = [['Date', 'Heure', 'Catégorie', 'Groupe', 'Montant', 'Note', 'Origine']];
  for (const e of S.exps.slice().sort((a, b) => (a.at < b.at ? -1 : 1))) {
    const c = catById(e.cat);
    rows.push([e.at.slice(0, 10), e.at.slice(11, 16), c?.name || '', groupById(c?.groupId)?.name || '', csvMoney(e.amount) || '0,00', e.note || '', { import: 'import', rec: 'automatique' }[e.src] || 'saisie']);
  }
  saveFile(`depenses-detail-${nowYM()}.csv`, L.toCSV(rows));
}
async function saveFile(name, text) {
  const file = new File([text], name, { type: 'text/csv' });
  if (/iPhone|iPad|Android/i.test(navigator.userAgent) && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file); a.download = name; document.body.append(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// ---------- Feuille, toast, montant ----------
function sheet(html) { const s = $('#sheet'); s.innerHTML = html; $('#sheet-wrap').hidden = false; return s; }
function closeSheet() { $('#sheet-wrap').hidden = true; $('#sheet').innerHTML = ''; if (sheetCancel) { const f = sheetCancel; sheetCancel = null; f(); } }
let sheetCancel = null;
$('#sheet-wrap').addEventListener('click', (e) => { if (e.target.id === 'sheet-wrap') closeSheet(); });

/** Demande un montant : résout centimes, null (effacé) ou undefined (annulé). */
function askAmount(title, current) {
  return new Promise((resolve) => {
    const sh = sheet(`<h3>${esc(title)}</h3>
      <div class="field"><input id="a-val" inputmode="decimal" placeholder="Montant en €" value="${current ? fmtNum(current).replace(/[  ]/g, '') : ''}"></div>
      <div class="actions">${current ? '<button class="btn danger" id="a-clear">Retirer</button>' : '<button class="btn" id="a-cancel">Annuler</button>'}<button class="btn primary" id="a-ok">Enregistrer</button></div>`);
    sheetCancel = () => resolve(undefined);
    const inp = $('#a-val', sh); setTimeout(() => inp.focus(), 50);
    const done = (v) => { sheetCancel = null; closeSheet(); resolve(v); };
    $('#a-ok', sh).onclick = () => {
      if (!inp.value.trim()) return done(null);
      const v = L.parseAmount(inp.value); if (v == null || v <= 0) return shake(inp);
      done(v);
    };
    inp.onkeydown = (e) => { if (e.key === 'Enter') $('#a-ok', sh).click(); };
    const cl = $('#a-clear', sh); if (cl) cl.onclick = () => done(null);
    const ca = $('#a-cancel', sh); if (ca) ca.onclick = () => done(undefined);
  });
}

let toastT;
function toast(msg, { cls = '', action, onAction, ms = 3000 } = {}) {
  const t = $('#toast');
  t.className = 'toast ' + cls;
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button>${esc(action)}</button>` : ''}`;
  t.hidden = false;
  if (action) t.querySelector('button').onclick = () => { t.hidden = true; onAction(); };
  clearTimeout(toastT);
  toastT = setTimeout(() => { t.hidden = true; }, action ? 5000 : ms);
}

// ---------- Service worker, retour au premier plan ----------
function registerSW() {
  if (!('serviceWorker' in navigator) || LOCAL) return;
  let hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) $('#update').hidden = false; hadController = true; });
  navigator.serviceWorker.register('sw.js').then((reg) => {
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch(console.error);
}
$('#update').onclick = () => location.reload();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !S.ready) return;
  S.chipOrder = null;
  if (S.view === 'add' && !S.amount) S.whenTouched = false;
  applyRecurring();
  scheduleRender();
});

boot();
