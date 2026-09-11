// IndexedDB key-value store. One project at a time; every key is prefixed.
//   project:*  the current presentation   audio:*  generated clips   app:*  preferences

const DB_NAME = 'presentice';
const STORE = 'kv';
const MAX_KEY = '\uffff';
let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      let req;
      try {
        req = indexedDB.open(DB_NAME, 1);
      } catch (err) {
        reject(err);
        return;
      }
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => {
        const db = req.result;
        // Another tab upgrading, or the browser dropping the connection: reopen next time.
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        db.onclose = () => {
          dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('The saved data is in use by another tab.'));
    });
    // A failed open must not stay failed forever.
    dbPromise.catch(() => {
      dbPromise = null;
    });
  }
  return dbPromise;
}

async function run(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(STORE, mode);
    } catch (err) {
      dbPromise = null;
      reject(err);
      return;
    }
    let req;
    try {
      req = fn(tx.objectStore(STORE));
    } catch (err) {
      // Undo whatever fn already queued in this transaction: all or nothing.
      try {
        tx.abort();
      } catch {
        // The transaction already finished.
      }
      reject(err);
      return;
    }
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('The save was interrupted.'));
  });
}

export const get = (key) => run('readonly', (s) => s.get(key));
export const set = (key, value) => run('readwrite', (s) => s.put(value, key));

export function keys(prefix) {
  return run('readonly', (s) => s.getAllKeys(IDBKeyRange.bound(prefix, `${prefix}${MAX_KEY}`)));
}

/** Delete many keys in one transaction. */
export function delMany(list) {
  if (!list.length) return Promise.resolve();
  return run('readwrite', (s) => {
    for (const key of list) s.delete(key);
  });
}

/**
 * Replace the current project and drop its audio, all in one transaction:
 * either everything is saved or nothing changes.
 * @param {Record<string, unknown>} entries key -> value
 */
export function replaceProject(entries) {
  return run('readwrite', (s) => {
    s.delete(IDBKeyRange.bound('project:', `project:${MAX_KEY}`));
    s.delete(IDBKeyRange.bound('audio:', `audio:${MAX_KEY}`));
    for (const [key, value] of Object.entries(entries)) s.put(value, key);
  });
}

/** True when an error means the device is out of storage space. */
export function isQuotaError(err) {
  return err?.name === 'QuotaExceededError' || /quota/i.test(String(err?.message || ''));
}

export async function requestPersistence() {
  try {
    if (navigator.storage?.persist) await navigator.storage.persist();
  } catch {
    // Not supported or refused: the app still works, the browser may evict data.
  }
}
