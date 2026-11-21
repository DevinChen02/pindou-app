// 本地数据库（IndexedDB）。所有数据只存在这台手机的浏览器里。
//   stock         每个仓库每个色号的库存（v3 起）：{ wh, code, stock, threshold|null, updatedAt }，主键 [wh, code]
//   colors        v2 以前的库存（每个色号一条，没有仓库）：v3 升级时整个拷进 stock 的“我的库存”（main），之后不再读写，留着当备份
//   patterns      图纸：{ id, name, createdAt, status, items:[{code,count}], statedTotal, thumb, txId, build?:{ wh, … } }
//   transactions  库存流水：{ id, time, type, wh, patternId, note, deltas:[{code, delta, before, after}], undone }（没有 wh 的是 main）
//   images        图纸原图（JPEG dataURL）：{ id, dataUrl, w, h, name, createdAt }
//   kv            设置、仓库列表（warehouses）、未完成的核对进度等：{ key, value }

const DB_NAME = 'pindou-counter';
// v2：新增 images（保存图纸原图，方便随时放大查看）
// v3：多个仓库：新增 stock（[仓库, 色号] 一条），colors 里的库存搬进“我的库存”（main）
const DB_VERSION = 3;
export const MAIN_WH = 'main';
let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = e => {
      const db = r.result;
      if (!db.objectStoreNames.contains('colors')) db.createObjectStore('colors', { keyPath: 'code' });
      if (!db.objectStoreNames.contains('patterns')) db.createObjectStore('patterns', { keyPath: 'id', autoIncrement: true });
      if (!db.objectStoreNames.contains('transactions')) {
        const s = db.createObjectStore('transactions', { keyPath: 'id', autoIncrement: true });
        s.createIndex('time', 'time');
      }
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('images')) db.createObjectStore('images', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('stock')) {
        const st = db.createObjectStore('stock', { keyPath: ['wh', 'code'] });
        st.createIndex('wh', 'wh');
        // 老数据（v1、v2）：每个色号的库存原样搬进“我的库存”。和建表在同一个升级事务里：要么全搬完，要么数据库还是老版本
        if (e.oldVersion > 0) {
          const c = r.transaction.objectStore('colors').openCursor();
          c.onsuccess = () => {
            const cur = c.result;
            if (!cur) return;
            st.put({ ...cur.value, wh: MAIN_WH });
            cur.continue();
          };
        }
      }
    };
    r.onsuccess = () => {
      const db = r.result;
      // 新版本要升级数据库时，旧页面主动让出
      db.onversionchange = () => db.close();
      resolve(db);
    };
    r.onerror = () => reject(r.error);
    r.onblocked = () => console.warn('数据库升级被其他打开的页面挡住，关闭它们后会自动继续');
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

/** 按索引取一批（比如某个仓库的全部库存） */
export async function getAllByIndex(store, index, key) {
  const db = await openDB();
  return wrap(db.transaction(store).objectStore(store).index(index).getAll(key));
}

export async function getAllKeys(store) {
  const db = await openDB();
  return wrap(db.transaction(store).objectStore(store).getAllKeys());
}

/** 逐条读（不会一次把所有大图都读进内存） */
export async function forEach(store, fn) {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const r = db.transaction(store).objectStore(store).openCursor();
    r.onsuccess = () => {
      const c = r.result;
      if (!c) return resolve();
      fn(c.value);
      c.continue();
    };
    r.onerror = () => reject(r.error);
  });
}

export async function clearAll() {
  const db = await openDB();
  const stores = ['colors', 'stock', 'patterns', 'transactions', 'kv', 'images'];
  await new Promise((resolve, reject) => {
    const t = db.transaction(stores, 'readwrite');
    for (const s of stores) t.objectStore(s).clear();
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
}
