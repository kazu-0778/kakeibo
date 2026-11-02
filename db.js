// データアクセス層：Supabase とのやり取りはすべてここに集約
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

function check({ data, error }) {
  if (error) throw error;
  return data;
}

export const db = {
  // ---- 認証 ----
  async getUser() {
    const { data } = await sb.auth.getSession();
    return data.session?.user ?? null;
  },
  async signIn(email, password) {
    check(await sb.auth.signInWithPassword({ email, password }));
  },
  async signOut() {
    await sb.auth.signOut();
  },

  // ---- 世帯 ----
  async ensureHousehold() {
    return check(await sb.rpc('ensure_household'));
  },
  async getHousehold(id) {
    return check(await sb.from('households').select('*').eq('id', id).single());
  },
  async renameHousehold(id, name) {
    check(await sb.from('households').update({ name }).eq('id', id));
  },

  // ---- カテゴリ ----
  async listCategories(hh) {
    return check(await sb.from('categories').select('*').eq('household_id', hh)
      .order('sort_order').order('created_at'));
  },
  async saveCategory(cat) {
    const { id, ...rest } = cat;
    if (id) return check(await sb.from('categories').update(rest).eq('id', id).select().single());
    return check(await sb.from('categories').insert(rest).select().single());
  },
  // 使用中なら削除できないので false を返す（呼び出し側で非表示に切替）
  async deleteCategory(id) {
    const { error } = await sb.from('categories').delete().eq('id', id);
    if (error) {
      if (error.code === '23503') return false;
      throw error;
    }
    return true;
  },

  // ---- 収支 ----
  async listTransactions(hh, from, to) {
    // from <= date < to
    const rows = [];
    const page = 1000;
    for (let offset = 0; ; offset += page) {
      const data = check(await sb.from('transactions').select('*').eq('household_id', hh)
        .gte('date', from).lt('date', to)
        .order('date', { ascending: false }).order('created_at', { ascending: false })
        .range(offset, offset + page - 1));
      rows.push(...data);
      if (data.length < page) break;
    }
    return rows;
  },
  async listRecent(hh, limit = 8) {
    return check(await sb.from('transactions').select('*').eq('household_id', hh)
      .order('created_at', { ascending: false }).limit(limit));
  },
  async listPending(hh) {
    return check(await sb.from('transactions').select('*').eq('household_id', hh)
      .eq('status', 'pending').order('date'));
  },
  async saveTransaction(tx) {
    const { id, ...rest } = tx;
    if (id) return check(await sb.from('transactions').update(rest).eq('id', id).select().single());
    return check(await sb.from('transactions').insert(rest).select().single());
  },
  async deleteTransaction(id) {
    check(await sb.from('transactions').delete().eq('id', id));
  },

  // ---- 固定費 ----
  async listRecurring(hh) {
    return check(await sb.from('recurring_items').select('*').eq('household_id', hh)
      .order('day_of_month').order('created_at'));
  },
  async saveRecurring(item) {
    const { id, ...rest } = item;
    if (id) return check(await sb.from('recurring_items').update(rest).eq('id', id).select().single());
    return check(await sb.from('recurring_items').insert(rest).select().single());
  },
  async deleteRecurring(id) {
    check(await sb.from('recurring_items').delete().eq('id', id));
  },
  async processRecurring(hh) {
    return check(await sb.rpc('process_recurring', { p_household: hh }));
  },
};
