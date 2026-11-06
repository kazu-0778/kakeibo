// 【一時的】Supabase に保存されていたデータをスマホへ引き継ぐ
// 引き継ぎが終わったら、このファイル・supabase.js・config.js・schema.sql は削除する
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

let client = null;
async function getClient() {
  if (!window.supabase) {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'supabase.js';
      s.onload = resolve;
      s.onerror = () => reject(new Error('引き継ぎ用の部品を読み込めません。通信状態を確認してください'));
      document.head.append(s);
    });
  }
  client ??= window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: true } });
  return client;
}

const check = ({ data, error }) => { if (error) throw error; return data; };

async function fetchAll(sb, table) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const data = check(await sb.from(table).select('*').order('created_at').range(from, from + 999));
    rows.push(...data);
    if (data.length < 1000) break;
  }
  return rows;
}

// 以前のログインが残っていれば true
export async function isSignedIn() {
  const sb = await getClient();
  const { data } = await sb.auth.getSession();
  return !!data.session;
}

export async function signIn(email, password) {
  const sb = await getClient();
  check(await sb.auth.signInWithPassword({ email, password }));
}

// Supabase から全データを読み、スマホ用の形にそろえて返す
export async function fetchFromSupabase() {
  const sb = await getClient();
  const [cats, txs, recs] = await Promise.all([
    fetchAll(sb, 'categories'), fetchAll(sb, 'transactions'), fetchAll(sb, 'recurring_items'),
  ]);
  return {
    categories: cats.map((c) => ({
      id: c.id, kind: c.kind, major: c.major, name: c.name, icon: c.icon,
      sort_order: c.sort_order, archived: c.archived, created_at: c.created_at,
    })),
    transactions: txs.map((t) => ({
      id: t.id, category_id: t.category_id, amount: t.amount, date: t.date, memo: t.memo,
      status: t.status, recurring_id: t.recurring_id, created_at: t.created_at,
    })),
    recurring: recs.map((r) => ({
      id: r.id, category_id: r.category_id, name: r.name, amount: r.amount, amount_type: r.amount_type,
      interval_months: r.interval_months, day_of_month: r.day_of_month, next_date: r.next_date,
      active: r.active, created_at: r.created_at,
    })),
  };
}
