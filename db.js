// データアクセス層：すべてのデータをスマホ内（IndexedDB）に保存する
// 通信は一切行わない

const DB_NAME = 'kakeibo';
const DB_VERSION = 1;

const DEFAULT_CATEGORIES = [
  ['expense', 'consumption', '食費', '🍙'], ['expense', 'consumption', '日用品', '🧴'],
  ['expense', 'consumption', '住居', '🏠'], ['expense', 'consumption', '電気', '💡'],
  ['expense', 'consumption', 'ガス', '🔥'], ['expense', 'consumption', '水道', '🚰'],
  ['expense', 'consumption', '通信', '📱'], ['expense', 'consumption', '交通', '🚃'],
  ['expense', 'consumption', '医療', '🏥'],
  ['expense', 'waste', '外食', '🍜'], ['expense', 'waste', '飲み会', '🍺'],
  ['expense', 'waste', '趣味', '🎮'], ['expense', 'waste', '衝動買い', '🛍️'],
  ['expense', 'investment', '積立投資', '📈'], ['expense', 'investment', '自己投資', '📚'],
  ['expense', 'investment', '貯金', '🐷'],
  ['income', null, '給与', '💴'], ['income', null, '賞与', '💰'],
  ['income', null, '副業', '💼'], ['income', null, '臨時収入', '🎁'],
];
const GROUP_BASE = { consumption: 0, waste: 100, investment: 200 };

// ---------------------------------------------------------------------
// IndexedDB の薄いラッパー
// ---------------------------------------------------------------------
const uid = () => (crypto.randomUUID ? crypto.randomUUID()
  : 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
const nowIso = () => new Date().toISOString();
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const monthDay = (y, m, day) => new Date(y, m, Math.min(day, new Date(y, m + 1, 0).getDate()));

const req = (r) => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});

let dbPromise = null;
function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('categories', { keyPath: 'id' });
        const t = d.createObjectStore('transactions', { keyPath: 'id' });
        t.createIndex('date', 'date');
        t.createIndex('status', 'status');
        t.createIndex('category_id', 'category_id');
        d.createObjectStore('recurring', { keyPath: 'id' });
        d.createObjectStore('meta', { keyPath: 'key' });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(new Error('データベースを開けません。アプリを一度閉じてください'));
    });
  }
  return dbPromise;
}

// stores: 文字列または配列、fn(storeMap) の戻り値で resolve（トランザクション完了後）
async function run(stores, mode, fn) {
  const d = await open();
  const names = Array.isArray(stores) ? stores : [stores];
  return new Promise((resolve, reject) => {
    const tx = d.transaction(names, mode);
    const map = Object.fromEntries(names.map((n) => [n, tx.objectStore(n)]));
    let result;
    Promise.resolve(fn(map)).then((v) => { result = v; }, (e) => { tx.abort(); reject(e); });
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('保存を中止しました'));
  });
}
const getAll = (store) => run(store, 'readonly', (s) => req(s[store].getAll()));

// 既存の行に変更点だけを重ねて保存
async function upsert(store, row, defaults) {
  return run(store, 'readwrite', async (s) => {
    const cur = row.id ? await req(s[store].get(row.id)) : null;
    const next = cur ? { ...cur, ...row } : { ...defaults(), ...row, id: row.id ?? uid() };
    await req(s[store].put(next));
    return next;
  });
}

async function getMeta(key) {
  const row = await run('meta', 'readonly', (s) => req(s.meta.get(key)));
  return row?.value;
}
async function setMeta(key, value) {
  await run('meta', 'readwrite', (s) => req(s.meta.put({ key, value })));
}

const byOrder = (a, b) => a.sort_order - b.sort_order || String(a.created_at).localeCompare(String(b.created_at));
const byDateDesc = (a, b) => b.date.localeCompare(a.date) || String(b.created_at).localeCompare(String(a.created_at));

// ---------------------------------------------------------------------
// 公開 API
// ---------------------------------------------------------------------
export const db = {
  // 初回起動時：初期カテゴリを入れる
  async init() {
    await open();
    if (!(await getMeta('installed_at'))) {
      const t = nowIso();
      await run(['categories', 'meta'], 'readwrite', async (s) => {
        const counts = {};
        for (const [kind, major, name, icon] of DEFAULT_CATEGORIES) {
          const g = kind === 'income' ? 'income' : major;
          counts[g] = (counts[g] ?? 0) + 1;
          const base = kind === 'income' ? 300 : GROUP_BASE[major];
          await req(s.categories.put({
            id: uid(), kind, major, name, icon, sort_order: base + counts[g] * 5, archived: false, created_at: t,
          }));
        }
        await req(s.meta.put({ key: 'installed_at', value: t }));
      });
    }
  },
  getMeta,
  setMeta,

  // スマホに「このデータを消さないで」と依頼する
  async persist() {
    if (!navigator.storage?.persist) return null;
    if (await navigator.storage.persisted()) return true;
    return navigator.storage.persist();
  },
  async isPersisted() {
    return navigator.storage?.persisted ? navigator.storage.persisted() : null;
  },

  // ---- カテゴリ ----
  async listCategories() {
    return (await getAll('categories')).sort(byOrder);
  },
  saveCategory(cat) {
    return upsert('categories', cat, () => ({ archived: false, sort_order: 0, created_at: nowIso() }));
  },
  // 使用中なら削除せず false を返す（呼び出し側で非表示に切替）
  async deleteCategory(id) {
    return run(['categories', 'transactions', 'recurring'], 'readwrite', async (s) => {
      const used = await req(s.transactions.index('category_id').count(id));
      const recs = await req(s.recurring.getAll());
      if (used || recs.some((r) => r.category_id === id)) return false;
      await req(s.categories.delete(id));
      return true;
    });
  },

  // ---- 収支 ----
  // from <= date < to
  async listTransactions(from, to) {
    const rows = await run('transactions', 'readonly',
      (s) => req(s.transactions.index('date').getAll(IDBKeyRange.bound(from, to, false, true))));
    return rows.sort(byDateDesc);
  },
  async listRecent(limit = 8) {
    const rows = await getAll('transactions');
    return rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, limit);
  },
  async listPending() {
    const rows = await run('transactions', 'readonly', (s) => req(s.transactions.index('status').getAll('pending')));
    return rows.sort((a, b) => a.date.localeCompare(b.date));
  },
  saveTransaction(t) {
    return upsert('transactions', t, () => ({ status: 'confirmed', memo: null, recurring_id: null, created_at: nowIso() }));
  },
  async deleteTransaction(id) {
    await run('transactions', 'readwrite', (s) => req(s.transactions.delete(id)));
  },

  // ---- 固定費 ----
  async listRecurring() {
    return (await getAll('recurring')).sort((a, b) => a.day_of_month - b.day_of_month
      || String(a.created_at).localeCompare(String(b.created_at)));
  },
  saveRecurring(item) {
    return upsert('recurring', item, () => ({ active: true, created_at: nowIso() }));
  },
  async deleteRecurring(id) {
    // 記録済みの分は残し、固定費とのつながりだけ外す
    await run(['recurring', 'transactions'], 'readwrite', async (s) => {
      for (const t of await req(s.transactions.getAll())) {
        if (t.recurring_id === id) await req(s.transactions.put({ ...t, recurring_id: null }));
      }
      await req(s.recurring.delete(id));
    });
  },
  // 期日が来た固定費を記録（固定→確定、変動→確認待ち）。何度呼んでも二重にならない
  async processRecurring() {
    const today = ymd(new Date());
    return run(['recurring', 'transactions'], 'readwrite', async (s) => {
      const items = (await req(s.recurring.getAll())).filter((r) => r.active && r.next_date <= today);
      if (!items.length) return 0;
      const existing = new Set((await req(s.transactions.getAll()))
        .filter((t) => t.recurring_id).map((t) => `${t.recurring_id}|${t.date}`));
      let count = 0;
      for (const r of items) {
        let next = r.next_date;
        while (next <= today) {
          if (!existing.has(`${r.id}|${next}`)) {
            await req(s.transactions.put({
              id: uid(), category_id: r.category_id, amount: r.amount, date: next, memo: r.name,
              status: r.amount_type === 'fixed' ? 'confirmed' : 'pending', recurring_id: r.id, created_at: nowIso(),
            }));
            existing.add(`${r.id}|${next}`);
            count++;
          }
          const d = parseYmd(next);
          next = ymd(monthDay(d.getFullYear(), d.getMonth() + r.interval_months, r.day_of_month));
        }
        await req(s.recurring.put({ ...r, next_date: next }));
      }
      return count;
    });
  },

  // ---- バックアップ・復元・引き継ぎ ----
  async exportAll() {
    const [categories, transactions, recurring] = await Promise.all(
      [getAll('categories'), getAll('transactions'), getAll('recurring')]);
    return { categories, transactions, recurring };
  },
  // 今のデータをすべて置き換える
  async replaceAll({ categories, transactions, recurring }) {
    await run(['categories', 'transactions', 'recurring'], 'readwrite', async (s) => {
      await Promise.all([req(s.categories.clear()), req(s.transactions.clear()), req(s.recurring.clear())]);
      for (const c of categories) await req(s.categories.put(c));
      for (const r of recurring) await req(s.recurring.put(r));
      for (const t of transactions) await req(s.transactions.put(t));
    });
  },
  async countTransactions() {
    return run('transactions', 'readonly', (s) => req(s.transactions.count()));
  },
};
