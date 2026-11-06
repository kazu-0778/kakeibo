// CSV バックアップ（出力・復元）
// 1つのCSVに「記録」「カテゴリ」「固定費」をまとめて入れる。Excelでそのまま開ける（UTF-8 BOM付き）。

const COLS = [
  'データ種別', '日付', '区分', '大分類', 'カテゴリ', 'アイコン', '金額', 'メモ', '状態',
  '名前', '金額タイプ', '頻度(か月)', '支払日', '次回日', '有効', '並び順', '非表示',
  'ID', 'カテゴリID', '固定費ID', '作成日時',
];
const KIND = { expense: '支出', income: '収入' };
const MAJOR = { consumption: '消費', waste: '浪費', investment: '投資' };
const STATUS = { confirmed: '確定', pending: '確認待ち' };
const ATYPE = { fixed: '固定', variable: '変動' };
const rev = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [v, k]));
const R_KIND = rev(KIND); const R_MAJOR = rev(MAJOR); const R_STATUS = rev(STATUS); const R_ATYPE = rev(ATYPE);
const YES = 'はい'; const NO = 'いいえ';

const cell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv({ categories, transactions, recurring }) {
  const cat = new Map(categories.map((c) => [c.id, c]));
  const rows = [COLS];
  const line = (o) => rows.push(COLS.map((k) => o[k] ?? ''));
  const sortedTx = [...transactions].sort((a, b) => a.date.localeCompare(b.date)
    || String(a.created_at).localeCompare(String(b.created_at)));
  for (const t of sortedTx) {
    const c = cat.get(t.category_id) ?? {};
    line({
      データ種別: '記録', 日付: t.date, 区分: KIND[c.kind] ?? '', 大分類: MAJOR[c.major] ?? '',
      カテゴリ: c.name ?? '', アイコン: c.icon ?? '', 金額: t.amount, メモ: t.memo ?? '', 状態: STATUS[t.status],
      ID: t.id, カテゴリID: t.category_id, 固定費ID: t.recurring_id ?? '', 作成日時: t.created_at,
    });
  }
  for (const c of [...categories].sort((a, b) => a.sort_order - b.sort_order)) {
    line({
      データ種別: 'カテゴリ', 区分: KIND[c.kind], 大分類: MAJOR[c.major] ?? '', カテゴリ: c.name, アイコン: c.icon,
      並び順: c.sort_order, 非表示: c.archived ? YES : NO, ID: c.id, 作成日時: c.created_at,
    });
  }
  for (const r of recurring) {
    const c = cat.get(r.category_id) ?? {};
    line({
      データ種別: '固定費', 区分: KIND[c.kind] ?? '', 大分類: MAJOR[c.major] ?? '', カテゴリ: c.name ?? '',
      アイコン: c.icon ?? '', 金額: r.amount, 名前: r.name, 金額タイプ: ATYPE[r.amount_type],
      '頻度(か月)': r.interval_months, 支払日: r.day_of_month, 次回日: r.next_date, 有効: r.active ? YES : NO,
      ID: r.id, カテゴリID: r.category_id, 作成日時: r.created_at,
    });
  }
  return '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

// RFC 4180 形式のCSVを読む
function parseCsv(text) {
  const rows = [];
  let row = []; let field = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v !== ''));
}

// CSV → { categories, transactions, recurring }。形式がおかしければ例外
export function fromCsv(text) {
  const rows = parseCsv(text.replace(/^﻿/, ''));
  if (!rows.length) throw new Error('ファイルが空です');
  const head = rows[0].map((h) => h.trim());
  const idx = Object.fromEntries(COLS.map((c) => [c, head.indexOf(c)]));
  for (const need of ['データ種別', 'ID', 'カテゴリID']) {
    if (idx[need] < 0) throw new Error('この家計簿のバックアップCSVではありません');
  }
  const get = (r, k) => (idx[k] >= 0 ? (r[idx[k]] ?? '').trim() : '');
  const num = (v, line) => {
    const n = Number(String(v).replace(/[,¥\s]/g, ''));
    if (!Number.isFinite(n)) throw new Error(`${line}行目：数値が読み取れません（${v}）`);
    return Math.round(n);
  };
  const date = (v, line) => {
    const m = String(v).match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
    if (!m) throw new Error(`${line}行目：日付が読み取れません（${v}）`);
    return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  };
  const now = new Date().toISOString();
  const categories = []; const transactions = []; const recurring = [];
  rows.slice(1).forEach((r, i) => {
    const line = i + 2;
    const type = get(r, 'データ種別');
    const id = get(r, 'ID');
    if (!id) throw new Error(`${line}行目：IDがありません`);
    if (type === 'カテゴリ') {
      const kind = R_KIND[get(r, '区分')];
      if (!kind) throw new Error(`${line}行目：区分は「支出」か「収入」にしてください`);
      const major = kind === 'expense' ? R_MAJOR[get(r, '大分類')] : null;
      if (kind === 'expense' && !major) throw new Error(`${line}行目：大分類は「消費・浪費・投資」のどれかにしてください`);
      categories.push({
        id, kind, major, name: get(r, 'カテゴリ') || '名称なし', icon: get(r, 'アイコン') || '📁',
        sort_order: get(r, '並び順') ? num(get(r, '並び順'), line) : 0,
        archived: get(r, '非表示') === YES, created_at: get(r, '作成日時') || now,
      });
    } else if (type === '記録') {
      transactions.push({
        id, category_id: get(r, 'カテゴリID'), amount: num(get(r, '金額'), line), date: date(get(r, '日付'), line),
        memo: get(r, 'メモ') || null, status: R_STATUS[get(r, '状態')] ?? 'confirmed',
        recurring_id: get(r, '固定費ID') || null, created_at: get(r, '作成日時') || now,
      });
    } else if (type === '固定費') {
      recurring.push({
        id, category_id: get(r, 'カテゴリID'), name: get(r, '名前') || '固定費', amount: num(get(r, '金額'), line),
        amount_type: R_ATYPE[get(r, '金額タイプ')] ?? 'fixed',
        interval_months: num(get(r, '頻度(か月)') || '1', line), day_of_month: num(get(r, '支払日') || '1', line),
        next_date: date(get(r, '次回日'), line), active: get(r, '有効') !== NO, created_at: get(r, '作成日時') || now,
      });
    } else {
      throw new Error(`${line}行目：データ種別「${type}」は読み取れません`);
    }
  });
  if (!categories.length) throw new Error('カテゴリが1件もありません');
  // カテゴリが見つからない記録・固定費がないか確認
  const ids = new Set(categories.map((c) => c.id));
  const lost = [...transactions, ...recurring].filter((x) => !ids.has(x.category_id));
  if (lost.length) throw new Error(`カテゴリが見つからない記録が${lost.length}件あります`);
  const recIds = new Set(recurring.map((x) => x.id));
  transactions.forEach((t) => { if (t.recurring_id && !recIds.has(t.recurring_id)) t.recurring_id = null; });
  return { categories, transactions, recurring };
}

// スマホの「共有」メニュー（Googleドライブ等）で保存。使えなければダウンロード
export async function saveFile(text, filename, { share = true } = {}) {
  const file = new File([text], filename, { type: 'text/csv' });
  if (share && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return 'shared';
    } catch (e) {
      if (e.name === 'AbortError') return 'cancelled';
      // 共有できない場合はダウンロードに切り替え
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return 'downloaded';
}
