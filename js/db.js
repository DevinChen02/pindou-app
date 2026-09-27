// 本地数据库（IndexedDB）。所有数据只存在这台手机的浏览器里。
//   colors        每个色号的库存：{ code, stock, threshold|null, updatedAt }
//   patterns      图纸：{ id, name, createdAt, status, items:[{code,count}], statedTotal, thumb, txId }
//   transactions  库存流水：{ id, time, type, patternId, note, deltas:[{code, delta, before, after}], undone }
//   kv            设置、未完成的核对进度等：{ key, value }

const DB_NAME = 'pindou-counter';
const DB_VERSION = 1;
let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('colors')) db.createObjectStore('colors', { keyPath: 'code' });
      if (!db.objectStoreNames.contains('patterns')) db.createObjectStore('patterns', { keyPath: 'id', autoIncrement: true });
      if (!db.objectStoreNames.contains('transactions')) {
        const s = db.createObjectStore('transactions', { keyPath: 'id', autoIncrement: true });
        s.createIndex('time', 'time');
      }
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'key' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error('数据库被占用，请关闭其他打开本应用的页面后重试'));
  });
  return dbPromise;
}

const wrap = r => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});

export async function get(store, key) {
  const db = await openDB();
  return wrap(db.transaction(store).objectStore(store).get(key));
}

export async function getAll(store) {
  const db = await openDB();
  return wrap(db.transaction(store).objectStore(store).getAll());
}

export async function put(store, value) {
  const db = await openDB();
  return wrap(db.transaction(store, 'readwrite').objectStore(store).put(value));
}

export async function del(store, key) {
  const db = await openDB();
  return wrap(db.transaction(store, 'readwrite').objectStore(store).delete(key));
}

/**
 * 在一个事务里做多步读写。fn(t) 里只能用回调式的 IDB 请求（不能 await 别的东西），
 * 可以调用 abort(err) 取消整个事务。
 */
export async function transaction(stores, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, 'readwrite');
    let result, abortErr = null;
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(abortErr || t.error);
    t.onabort = () => reject(abortErr || t.error || new Error('操作已取消'));
    const abort = err => { abortErr = err; try { t.abort(); } catch { /* 已结束 */ } };
    try {
      fn(t, v => { result = v; }, abort);
    } catch (e) {
      abort(e);
    }
  });
}

export async function clearAll() {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const t = db.transaction(['colors', 'patterns', 'transactions', 'kv'], 'readwrite');
    for (const s of ['colors', 'patterns', 'transactions', 'kv']) t.objectStore(s).clear();
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
}
