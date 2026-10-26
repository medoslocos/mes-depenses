// Couche de données : Firestore (avec cache hors ligne et file d'attente d'écritures)
// ou, en local avec ?demo, une version en mémoire pour tester l'interface sans compte.

const COLS = ['groups', 'categories', 'expenses', 'months'];
const KEY = { groups: 'groups', categories: 'cats', expenses: 'exps', months: 'months' };

export function firestoreStore(fb, db, uid) {
  const { collection, doc, onSnapshot, setDoc, deleteDoc, writeBatch } = fb;
  const col = (c) => collection(db, 'users', uid, c);
  const ref = (c, id) => doc(db, 'users', uid, c, id);
  const unsubs = [];
  return {
    subscribe(onData, onError) {
      const state = { groups: [], cats: [], exps: [], months: {}, loaded: {}, fromServer: {}, pendingBy: {} };
      for (const c of COLS) {
        unsubs.push(onSnapshot(col(c), { includeMetadataChanges: true }, (snap) => {
          const docs = snap.docs.map((d) => ({ id: d.id, ...d.data(), _p: d.metadata.hasPendingWrites }));
          if (c === 'months') state.months = Object.fromEntries(docs.map((d) => [d.id, d]));
          else state[KEY[c]] = docs;
          state.loaded[c] = true;
          state.fromServer[c] = !snap.metadata.fromCache;
          const n = docs.filter((d) => d._p).length;
          state.pendingBy[c] = n || (snap.metadata.hasPendingWrites ? 1 : 0);
          onData(state);
        }, onError));
      }
    },
    stop() { unsubs.splice(0).forEach((u) => u()); },
    newId(c) { return doc(col(c)).id; },
    // Les promesses ne se résolvent qu'au retour du réseau : on ne les attend pas, Firestore met en file d'attente.
    set(c, id, data) { return setDoc(ref(c, id), data).catch(onWriteError); },
    merge(c, id, data) { return setDoc(ref(c, id), data, { merge: true }).catch(onWriteError); },
    del(c, id) { return deleteDoc(ref(c, id)).catch(onWriteError); },
    batch(ops) {
      for (let i = 0; i < ops.length; i += 400) {
        const b = writeBatch(db);
        for (const o of ops.slice(i, i + 400)) {
          if (o.op === 'delete') b.delete(ref(o.col, o.id));
          else b.set(ref(o.col, o.id), o.data, o.op === 'merge' ? { merge: true } : {});
        }
        b.commit().catch(onWriteError);
      }
    },
  };
}

let writeErrorHandler = (e) => console.error(e);
export const setWriteErrorHandler = (fn) => { writeErrorHandler = fn; };
function onWriteError(e) { writeErrorHandler(e); }

export function demoStore() {
  const LS = 'depenses-demo';
  let data;
  try { data = JSON.parse(localStorage.getItem(LS)) || {}; } catch { data = {}; }
  for (const c of COLS) data[c] ??= {};
  let listener = null;
  const save = () => { try { localStorage.setItem(LS, JSON.stringify(data)); } catch {} };
  const emit = () => {
    if (!listener) return;
    const state = {
      groups: Object.entries(data.groups).map(([id, d]) => ({ id, ...d })),
      cats: Object.entries(data.categories).map(([id, d]) => ({ id, ...d })),
      exps: Object.entries(data.expenses).map(([id, d]) => ({ id, ...d })),
      months: Object.fromEntries(Object.entries(data.months).map(([id, d]) => [id, { id, ...d }])),
      loaded: Object.fromEntries(COLS.map((c) => [c, true])),
      fromServer: Object.fromEntries(COLS.map((c) => [c, true])),
      pendingBy: {},
    };
    listener(state);
  };
  const later = () => { save(); setTimeout(emit, 0); };
  const apply = (o) => {
    if (o.op === 'delete') delete data[o.col][o.id];
    else if (o.op === 'merge') data[o.col][o.id] = { ...(data[o.col][o.id] || {}), ...structuredClone(o.data) };
    else data[o.col][o.id] = structuredClone(o.data);
  };
  return {
    subscribe(onData) { listener = onData; setTimeout(emit, 50); },
    stop() { listener = null; },
    newId() { return Math.random().toString(36).slice(2, 12) + Date.now().toString(36); },
    set(col, id, d) { apply({ op: 'set', col, id, data: d }); later(); },
    merge(col, id, d) { apply({ op: 'merge', col, id, data: d }); later(); },
    del(col, id) { apply({ op: 'delete', col, id }); later(); },
    batch(ops) { ops.forEach(apply); later(); },
  };
}
