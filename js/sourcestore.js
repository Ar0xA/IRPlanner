// Saved copies of server source files, in IndexedDB, so the rules can be read with no connection.
// Whole files are kept rather than the numbers from them, so a newer planner can read them again.
// Every call resolves, with null or [] when storage is unavailable.

const DB_NAME = 'irplanner-sources';
const STORE = 'copies';
const MAX_COPIES = 6;

function open() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'key' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(mode, fn) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request?.result);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

const keyOf = source => `${source.repo}@${source.ref}`;

export async function listCopies() {
  try {
    const all = await withStore('readonly', store => store.getAll());
    return (all || []).sort((a, b) => b.at - a.at);
  } catch {
    return [];
  }
}

export async function loadCopy(source) {
  try {
    return (await withStore('readonly', store => store.get(keyOf(source)))) || null;
  } catch {
    return null;
  }
}

export async function saveCopy(source, files, commit) {
  try {
    await withStore('readwrite', store => store.put({ key: keyOf(source), source, files, commit, at: Date.now() }));
    const extra = (await listCopies()).slice(MAX_COPIES);
    for (const copy of extra) await withStore('readwrite', store => store.delete(copy.key));
  } catch { /* the rules still apply for this page view */ }
}
