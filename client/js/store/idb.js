// A tiny promise wrapper over IndexedDB — just enough for the op-log store.
//
// The handoff suggested Dexie; we deliberately keep the client DEPENDENCY-FREE
// and BUILDLESS (the whole app is served as static files, echoing the reference
// app's "runs with nothing but the server binary" ethos). This wrapper is ~60
// lines and covers everything oplog.js needs; swap in Dexie later if the schema
// grows. Browser-only — it touches `indexedDB`, so it is not exercised by the
// Node test suite (the pure reducer it feeds is).

import { registerVersion } from "../version.js";
registerVersion("js/store/idb.js", 1);

/** Open (creating/upgrading) a DB with the given object stores. */
export function openDb(name, version, stores) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, version);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [store, opts] of Object.entries(stores)) {
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, opts);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function run(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const os = tx.objectStore(store);
    let result;
    Promise.resolve(fn(os)).then((r) => { result = r; }).catch(reject);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

const wrap = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

/** Put a value (with an out-of-line or keyPath key). */
export const put = (db, store, value, key) =>
  run(db, store, "readwrite", (os) => wrap(key === undefined ? os.put(value) : os.put(value, key)));

/** Put many values in one transaction. */
export const putMany = (db, store, values) =>
  run(db, store, "readwrite", (os) => Promise.all(values.map((v) => wrap(os.put(v)))));

/** Get one value by key. */
export const get = (db, store, key) =>
  run(db, store, "readonly", (os) => wrap(os.get(key)));

/** Get every value in a store. */
export const getAll = (db, store) =>
  run(db, store, "readonly", (os) => wrap(os.getAll()));
