import { db } from './db.js';

// =====================================================================
// 定数・ユーティリティ
// =====================================================================
const MAJORS = [
  { key: 'consumption', label: '消費' },
  { key: 'waste', label: '浪費' },
  { key: 'investment', label: '投資' },
];
const MAJOR_LABEL = Object.fromEntries(MAJORS.map((m) => [m.key, m.label]));
const INTERVALS = [[1, '毎月'], [2, '2か月ごと'], [3, '3か月ごと'], [6, '半年ごと'], [12, '毎年']];
const INTERVAL_LABEL = Object.fromEntries(INTERVALS);
const EMOJIS = ('🍙 🍚 🍞 🥩 🥬 🍎 ☕ 🍜 🍣 🍔 🍕 🍰 🍺 🍷 🥤 🛒 🧴 🧻 🧺 🧹 👕 👟 💄 💇 '
  + '🏠 🛋️ 💡 🔥 🚰 📱 💻 📶 🚃 🚌 🚕 🚗 ⛽ 🅿️ ✈️ 🏨 🏥 💊 🦷 👶 🍼 🐶 🐱 🎓 📚 ✏️ '
  + '🎮 🎬 🎤 🎨 📷 🎵 ⚽ 🏋️ ⛳ 🎣 🎁 💐 🎉 🛍️ 💳 📈 💹 🐷 🏦 💰 💴 💵 💼 🪙 🧾 📄 '
  + '🛡️ ❤️ ⭐ 📦 🔧 🎫 🌱 💒 🎂 🧸').split(' ');
const WD = '日月火水木金土';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const todayStr = () => ymd(new Date());
const firstOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
const addMonths = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1);
const fmtDate = (s) => { const d = parseYmd(s); return `${d.getMonth() + 1}月${d.getDate()}日(${WD[d.getDay()]})`; };
const fmtDateLong = (s) => { const d = parseYmd(s); return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日(${WD[d.getDay()]})`; };
const fmtMonth = (d) => `${d.getFullYear()}年${d.getMonth() + 1}月`;
const yen = (n) => '¥' + Math.round(n).toLocaleString('ja-JP');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const monthDay = (base, day) => {
  const last = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
  return new Date(base.getFullYear(), base.getMonth(), Math.min(day, last));
};
const dayLabel = (d) => (d >= 31 ? '月末' : `${d}日`);

// 全角数字も受け付けて数値化
function parseAmount(v) {
  const digits = String(v).replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/[^\d]/g, '');
  return digits ? Math.min(Number(digits.slice(0, 9)), 999999999) : 0;
}
function bindAmountInput(input) {
  input.addEventListener('input', () => {
    const n = parseAmount(input.value);
    input.value = n ? n.toLocaleString('ja-JP') : '';
  });
}

// =====================================================================
// 状態
// =====================================================================
const state = {
  user: null,
  hh: null,
  household: null,
  categories: [],
  catMap: new Map(),
  pending: [],
  view: 'input',
  month: firstOfMonth(new Date()),
  period: 'month',
  catFilter: '',
  settingsKind: 'expense',
};

const catOf = (id) => state.catMap.get(id) ?? { name: '不明', icon: '❔', kind: 'expense', major: 'consumption' };
const toneOf = (cat) => (cat.kind === 'income' ? 'income' : cat.major);
const isIncome = (tx) => catOf(tx.category_id).kind === 'income';

function setCategories(list) {
  state.categories = list;
  state.catMap = new Map(list.map((c) => [c.id, c]));
}
const sortedCats = (kind, { includeArchived = false } = {}) => state.categories
  .filter((c) => c.kind === kind && (includeArchived || !c.archived))
  .sort((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at));

// =====================================================================
// トースト・モーダル・エラー
// =====================================================================
let toastTimer;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), isError ? 4000 : 2000);
}
function errMsg(e) {
  const m = e?.message ?? String(e);
  if (/fetch|network|load failed/i.test(m)) return 'ネットワークに接続できません';
  if (/invalid login/i.test(m)) return 'メールアドレスかパスワードが違います';
  if (/email not confirmed/i.test(m)) return 'メールアドレスが未確認です';
  return 'エラー：' + m;
}
async function guard(fn) {
  try { return await fn(); } catch (e) { console.error(e); toast(errMsg(e), true); return undefined; }
}

const modal = $('#modal');
const modalBody = $('#modal-body');
function openModal(title, html) {
  modalBody.innerHTML = `
    <div class="modal-head"><h2>${esc(title)}</h2>
      <button type="button" class="icon-btn" data-close aria-label="閉じる">✕</button></div>
    <div class="modal-content">${html}</div>`;
  $('[data-close]', modalBody).onclick = closeModal;
  modal.showModal();
  return modalBody;
}
function closeModal() {
  if (modal.open) modal.close();
  modalBody.innerHTML = '';
}
modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

// =====================================================================
// 収支フォーム（入力画面と編集モーダルで共用）
// =====================================================================
function catTile(cat, selected) {
  return `<button type="button" class="cat-tile" data-cat="${cat.id}" aria-pressed="${selected}">
    <span class="ic ${toneOf(cat)}">${esc(cat.icon)}</span><span class="nm">${esc(cat.name)}</span></button>`;
}

function mountTxForm(container, { tx = null, onSubmit, onDelete, allowCatEdit = false }) {
  const s = {
    kind: tx ? catOf(tx.category_id).kind : 'expense',
    categoryId: tx?.category_id ?? null,
    date: tx?.date ?? todayStr(),
  };
  const isPending = tx?.status === 'pending';
  container.innerHTML = `
    <form class="tx-form" novalidate>
      <div class="segmented block kind" role="tablist">
        <button type="button" data-kind="expense">支出</button>
        <button type="button" data-kind="income">収入</button>
      </div>
      <label class="amount-row"><span class="yen">¥</span>
        <input name="amount" inputmode="numeric" autocomplete="off" placeholder="0" aria-label="金額"></label>
      <div class="date-row">
        <label class="date-btn"><span class="cal" aria-hidden="true">📅</span><span data-date-label></span>
          <input type="date" name="date" aria-label="日付をカレンダーから選ぶ"></label>
        <div class="chips">
          <button type="button" data-quick="0">今日</button>
          <button type="button" data-quick="-1">昨日</button>
        </div>
      </div>
      <div data-cats></div>
      <input class="memo-input" name="memo" placeholder="メモ（任意）" maxlength="100" autocomplete="off">
      <div class="modal-foot">
        ${onDelete ? '<button type="button" class="btn danger" data-del>削除</button>' : ''}
        <button type="submit" class="btn primary">${tx ? (isPending ? '確定する' : '更新') : '記録する'}</button>
      </div>
    </form>`;
  const form = $('form', container);
  const amount = form.amount;
  const dateInput = form.date;
  bindAmountInput(amount);
  if (tx) {
    amount.value = tx.amount.toLocaleString('ja-JP');
    form.memo.value = tx.memo ?? '';
  }

  const renderKind = () => $$('[data-kind]', form).forEach((b) => b.setAttribute('aria-pressed', b.dataset.kind === s.kind));
  const renderDate = () => {
    dateInput.value = s.date;
    const today = todayStr();
    const y = new Date(); y.setDate(y.getDate() - 1);
    const badge = s.date === today ? '今日' : s.date === ymd(y) ? '昨日' : '';
    $('[data-date-label]', form).innerHTML = esc(fmtDate(s.date)) + (badge ? ` <span class="today-badge">${badge}</span>` : '');
    $$('[data-quick]', form).forEach((b) => {
      const d = new Date(); d.setDate(d.getDate() + Number(b.dataset.quick));
      b.setAttribute('aria-pressed', ymd(d) === s.date);
    });
  };
  const renderCats = () => {
    const box = $('[data-cats]', form);
    const cats = sortedCats(s.kind);
    // 編集中の記録が非表示カテゴリを使っている場合も選べるようにする
    if (s.categoryId && !cats.some((c) => c.id === s.categoryId)) {
      const cur = state.catMap.get(s.categoryId);
      if (cur && cur.kind === s.kind) cats.push(cur);
    }
    if (s.categoryId && !cats.some((c) => c.id === s.categoryId)) s.categoryId = null;
    // 入力画面では各グループの最後に「＋追加」タイルを出す
    const addTile = (major) => (allowCatEdit
      ? `<button type="button" class="cat-tile" data-add-cat-inline="${major}"><span class="ic add">＋</span><span class="nm">追加</span></button>`
      : '');
    const editLink = allowCatEdit
      ? '<button type="button" class="link-btn" data-goto-cats>カテゴリの編集・削除・並べ替え ›</button>'
      : '';
    if (!cats.length && !allowCatEdit) {
      box.innerHTML = '<p class="empty">カテゴリがありません。設定から追加してください。</p>';
      return;
    }
    if (s.kind === 'income') {
      box.innerHTML = `<div class="cat-grid">${cats.map((c) => catTile(c, c.id === s.categoryId)).join('')}${addTile('')}</div>${editLink}`;
    } else {
      box.innerHTML = MAJORS.map((m) => {
        const list = cats.filter((c) => c.major === m.key);
        if (!list.length && !allowCatEdit) return '';
        return `<div class="cat-group-title"><span class="dot" style="background:var(--${m.key})"></span>${m.label}</div>
          <div class="cat-grid">${list.map((c) => catTile(c, c.id === s.categoryId)).join('')}${addTile(m.key)}</div>`;
      }).join('') + editLink;
    }
  };

  form.addEventListener('click', (e) => {
    const k = e.target.closest('[data-kind]');
    if (k) { s.kind = k.dataset.kind; renderKind(); renderCats(); return; }
    const add = e.target.closest('[data-add-cat-inline]');
    if (add) {
      openCategoryEditor(null, s.kind, {
        major: add.dataset.addCatInline || undefined,
        onSaved: (saved) => { s.categoryId = saved?.id ?? null; renderCats(); },
      });
      return;
    }
    if (e.target.closest('[data-goto-cats]')) {
      state.settingsKind = s.kind; state.view = 'settings'; window.scrollTo(0, 0); renderView(); return;
    }
    const c = e.target.closest('[data-cat]');
    if (c) {
      s.categoryId = c.dataset.cat;
      $$('[data-cat]', form).forEach((b) => b.setAttribute('aria-pressed', b.dataset.cat === s.categoryId));
      return;
    }
    const q = e.target.closest('[data-quick]');
    if (q) { const d = new Date(); d.setDate(d.getDate() + Number(q.dataset.quick)); s.date = ymd(d); renderDate(); return; }
    if (e.target.closest('[data-del]')) onDelete?.();
  });
  // カレンダーを開く（対応ブラウザでは確実にピッカーを表示）
  dateInput.addEventListener('click', () => { try { dateInput.showPicker?.(); } catch { /* iOS等は標準動作 */ } });
  dateInput.addEventListener('change', () => { if (dateInput.value) { s.date = dateInput.value; renderDate(); } });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const value = parseAmount(amount.value);
    if (!value) { toast('金額を入力してください', true); amount.focus(); return; }
    if (!s.categoryId) { toast('カテゴリを選んでください', true); return; }
    const btn = $('button[type="submit"]', form);
    btn.disabled = true;
    const ok = await guard(() => onSubmit({
      amount: value, category_id: s.categoryId, date: s.date, memo: form.memo.value.trim() || null,
    }));
    btn.disabled = false;
    if (ok !== undefined && !tx) {
      // 次の入力に備えてリセット（支出/収入の選択は維持）
      amount.value = ''; form.memo.value = ''; s.categoryId = null; s.date = todayStr();
      renderDate(); renderCats();
    }
  });

  renderKind(); renderDate(); renderCats();
  return form;
}

function openTxEditor(tx) {
  const body = openModal(tx.status === 'pending' ? '確認待ちの記録' : '記録の編集', '<div data-form></div>');
  mountTxForm($('[data-form]', body), {
    tx,
    onSubmit: async (v) => {
      await db.saveTransaction({ id: tx.id, ...v, status: 'confirmed' });
      closeModal();
      toast(tx.status === 'pending' ? '確定しました' : '更新しました');
      await refreshAfterChange();
      return true;
    },
    onDelete: async () => {
      if (!confirm('この記録を削除しますか？')) return;
      await guard(async () => {
        await db.deleteTransaction(tx.id);
        closeModal();
        toast('削除しました');
        await refreshAfterChange();
      });
    },
  });
}

// =====================================================================
// 一覧の行
// =====================================================================
function txRow(tx, { showDate = false } = {}) {
  const cat = catOf(tx.category_id);
  const income = cat.kind === 'income';
  const sub = [showDate ? fmtDate(tx.date) : '', tx.memo && tx.memo !== cat.name ? tx.memo : ''].filter(Boolean).join(' · ');
  return `<button type="button" class="row" data-tx="${tx.id}">
    <span class="ic ${toneOf(cat)}">${esc(cat.icon)}</span>
    <span class="body"><span class="title">${esc(cat.name)}${tx.status === 'pending' ? '<span class="badge">確認待ち</span>' : ''}</span>
      ${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</span>
    <span class="amt ${income ? 'income' : ''}">${income ? '+' : ''}${yen(tx.amount)}</span>
  </button>`;
}
function bindTxRows(root, list) {
  const map = new Map(list.map((t) => [t.id, t]));
  root.onclick = (e) => {
    const r = e.target.closest('[data-tx]');
    if (r && map.has(r.dataset.tx)) openTxEditor(map.get(r.dataset.tx));
  };
}

// =====================================================================
// 確認待ち
// =====================================================================
async function loadPending() {
  state.pending = await db.listPending(state.hh);
  const b = $('#pending-banner');
  b.hidden = !state.pending.length;
  b.innerHTML = `🔔 <span>確認待ちの固定費が <b>${state.pending.length}件</b> あります</span><span class="arrow">›</span>`;
}

function openPendingModal() {
  const body = openModal('確認待ちの固定費', '<p class="muted" style="margin:0 0 4px;font-size:13px">金額を確認して「確定」を押してください。確定するまではグラフに含まれません。</p><div data-list></div>');
  const render = () => {
    const box = $('[data-list]', body);
    if (!state.pending.length) { box.innerHTML = '<p class="empty">確認待ちはありません 🎉</p>'; return; }
    box.innerHTML = state.pending.map((t) => {
      const cat = catOf(t.category_id);
      return `<div class="pending-item" data-id="${t.id}">
        <div class="top"><span class="ic ${toneOf(cat)}">${esc(cat.icon)}</span>
          <div><div style="font-weight:600">${esc(t.memo || cat.name)}</div><div class="muted" style="font-size:12px">${esc(fmtDateLong(t.date))} · ${esc(cat.name)}</div></div></div>
        <div class="inline">
          <input inputmode="numeric" value="${t.amount.toLocaleString('ja-JP')}" aria-label="金額">
          <button type="button" class="btn primary" data-ok>確定</button>
          <button type="button" class="icon-btn" data-skip aria-label="今回は記録しない" title="今回は記録しない">🗑️</button>
        </div></div>`;
    }).join('');
    $$('.pending-item input', box).forEach(bindAmountInput);
  };
  body.addEventListener('click', async (e) => {
    const item = e.target.closest('.pending-item');
    if (!item) return;
    const id = item.dataset.id;
    if (e.target.closest('[data-ok]')) {
      const amount = parseAmount($('input', item).value);
      await guard(async () => {
        await db.saveTransaction({ id, amount, status: 'confirmed' });
        toast('確定しました');
        await loadPending(); render(); refreshAfterChange(false);
      });
    } else if (e.target.closest('[data-skip]')) {
      if (!confirm('今回分を記録せずに削除しますか？')) return;
      await guard(async () => {
        await db.deleteTransaction(id);
        toast('削除しました');
        await loadPending(); render(); refreshAfterChange(false);
      });
    }
  });
  render();
}
$('#pending-banner').addEventListener('click', openPendingModal);

// =====================================================================
// 画面：入力
// =====================================================================
let inputMounted = false;
async function renderInput() {
  if (!inputMounted) {
    mountTxForm($('#input-form'), {
      onSubmit: async (v) => {
        await db.saveTransaction({ ...v, household_id: state.hh });
        toast(`${catOf(v.category_id).icon} ${yen(v.amount)} を記録しました`);
        await loadRecent();
        return true;
      },
      allowCatEdit: true,
    });
    inputMounted = true;
  }
  await loadRecent();
}
async function loadRecent() {
  const list = await db.listRecent(state.hh, 8);
  const box = $('#recent-list');
  box.innerHTML = list.length ? list.map((t) => txRow(t, { showDate: true })).join('') : '<p class="empty">まだ記録がありません</p>';
  bindTxRows(box, list);
}

// =====================================================================
// 月切替
// =====================================================================
function renderMonthNavs() {
  const yearMode = state.view === 'charts' && state.period === 'year';
  const label = yearMode ? `${state.month.getFullYear()}年` : fmtMonth(state.month);
  $$('[data-month-nav]').forEach((el) => {
    el.innerHTML = `<button type="button" class="icon-btn" data-step="-1" aria-label="前へ">‹</button>
      <span class="label">${label}</span>
      <button type="button" class="icon-btn" data-step="1" aria-label="次へ">›</button>`;
  });
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-month-nav] [data-step]');
  if (!b) return;
  const yearMode = state.view === 'charts' && state.period === 'year';
  state.month = addMonths(state.month, Number(b.dataset.step) * (yearMode ? 12 : 1));
  renderView();
});

// =====================================================================
// 画面：履歴
// =====================================================================
async function renderHistory() {
  renderMonthNavs();
  const from = ymd(state.month);
  const to = ymd(addMonths(state.month, 1));
  const list = await db.listTransactions(state.hh, from, to);
  const confirmed = list.filter((t) => t.status === 'confirmed');
  const inc = confirmed.filter(isIncome).reduce((a, t) => a + t.amount, 0);
  const exp = confirmed.filter((t) => !isIncome(t)).reduce((a, t) => a + t.amount, 0);
  $('#history-summary').innerHTML = `
    <div class="card"><div class="k">収入</div><div class="v" style="color:var(--income)">${yen(inc)}</div></div>
    <div class="card"><div class="k">支出</div><div class="v">${yen(exp)}</div></div>
    <div class="card"><div class="k">収支</div><div class="v ${inc - exp < 0 ? 'neg' : ''}">${inc - exp < 0 ? '-' : ''}${yen(Math.abs(inc - exp))}</div></div>`;

  const box = $('#history-list');
  if (!list.length) { box.innerHTML = '<p class="empty">この月の記録はありません</p>'; return; }
  const byDate = new Map();
  for (const t of list) { if (!byDate.has(t.date)) byDate.set(t.date, []); byDate.get(t.date).push(t); }
  box.innerHTML = [...byDate].map(([date, items]) => {
    const dayExp = items.filter((t) => t.status === 'confirmed' && !isIncome(t)).reduce((a, t) => a + t.amount, 0);
    return `<div class="day-head"><span>${esc(fmtDate(date))}</span><span>${dayExp ? '支出 ' + yen(dayExp) : ''}</span></div>
      <div class="card list">${items.map((t) => txRow(t)).join('')}</div>`;
  }).join('');
  bindTxRows(box, list);
}

// =====================================================================
// 画面：グラフ
// =====================================================================
const charts = {};
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const yenShort = (v) => (v >= 10000 ? `${(v / 10000).toLocaleString('ja-JP', { maximumFractionDigits: 1 })}万` : v.toLocaleString('ja-JP'));

$('#chart-period').addEventListener('click', (e) => {
  const b = e.target.closest('[data-period]');
  if (!b) return;
  state.period = b.dataset.period;
  $$('#chart-period [data-period]').forEach((x) => x.setAttribute('aria-pressed', x === b));
  renderView();
});
$('#cat-filter').addEventListener('click', (e) => {
  const b = e.target.closest('[data-major]');
  if (!b) return;
  state.catFilter = b.dataset.major;
  $$('#cat-filter [data-major]').forEach((x) => x.setAttribute('aria-pressed', x === b));
  renderCatBars();
});

let chartData = { range: [], trend: [], months: [] };

async function renderCharts() {
  renderMonthNavs();
  const yearMode = state.period === 'year';
  const rangeFrom = yearMode ? new Date(state.month.getFullYear(), 0, 1) : state.month;
  const rangeTo = yearMode ? new Date(state.month.getFullYear() + 1, 0, 1) : addMonths(state.month, 1);
  const trendFrom = yearMode ? rangeFrom : addMonths(state.month, -11);
  const trendTo = yearMode ? rangeTo : addMonths(state.month, 1);
  const from = trendFrom < rangeFrom ? trendFrom : rangeFrom;
  const to = trendTo > rangeTo ? trendTo : rangeTo;

  const all = (await db.listTransactions(state.hh, ymd(from), ymd(to))).filter((t) => t.status === 'confirmed');
  const inRange = (t, a, b) => t.date >= ymd(a) && t.date < ymd(b);
  chartData.range = all.filter((t) => inRange(t, rangeFrom, rangeTo));
  chartData.months = Array.from({ length: 12 }, (_, i) => addMonths(trendFrom, i));
  chartData.trend = all.filter((t) => inRange(t, trendFrom, trendTo));

  renderMajorChart();
  renderCatBars();
  renderIncomeBars();
  renderTrend();
}

function renderMajorChart() {
  const exp = chartData.range.filter((t) => !isIncome(t));
  const totals = MAJORS.map((m) => exp.filter((t) => catOf(t.category_id).major === m.key).reduce((a, t) => a + t.amount, 0));
  const sum = totals.reduce((a, b) => a + b, 0);
  const colors = MAJORS.map((m) => cssVar(`--${m.key}`));
  $('#major-center').innerHTML = `<div class="k">支出合計</div><div class="v">${yen(sum)}</div>`;
  $('#major-legend').innerHTML = MAJORS.map((m, i) => `
    <div class="legend-item"><span class="sw" style="background:var(--${m.key})"></span>
      <span class="nm">${m.label}</span><span class="pct">${sum ? Math.round((totals[i] / sum) * 100) : 0}%</span>
      <span class="val">${yen(totals[i])}</span></div>`).join('');

  charts.major?.destroy();
  charts.major = new Chart($('#chart-major'), {
    type: 'doughnut',
    data: {
      labels: sum ? MAJORS.map((m) => m.label) : ['記録なし'],
      datasets: [{
        data: sum ? totals : [1],
        backgroundColor: sum ? colors : [cssVar('--surface-2')],
        borderColor: cssVar('--surface'),
        borderWidth: 2,
        hoverOffset: 4,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '68%',
      plugins: {
        legend: { display: false },
        tooltip: {
          enabled: !!sum,
          callbacks: { label: (c) => ` ${c.label}: ${yen(c.raw)}（${Math.round((c.raw / sum) * 100)}%）` },
        },
      },
    },
  });
}

function barsHtml(rows, colorFn) {
  if (!rows.length) return '<p class="empty">記録がありません</p>';
  const max = rows[0].value;
  const total = rows.reduce((a, r) => a + r.value, 0);
  return rows.map((r) => `
    <div class="bar-item" title="${esc(r.cat.name)} ${yen(r.value)}">
      <span class="ic">${esc(r.cat.icon)}</span>
      <span class="nm">${esc(r.cat.name)}</span>
      <span class="val">${yen(r.value)} <span class="muted" style="font-weight:400">${Math.round((r.value / total) * 100)}%</span></span>
      <span class="track"><span class="fill" style="width:${(r.value / max) * 100}%;background:${colorFn(r.cat)}"></span></span>
    </div>`).join('');
}
function aggregateByCat(list) {
  const m = new Map();
  for (const t of list) m.set(t.category_id, (m.get(t.category_id) ?? 0) + t.amount);
  return [...m].map(([id, value]) => ({ cat: catOf(id), value })).filter((r) => r.value > 0).sort((a, b) => b.value - a.value);
}
function renderCatBars() {
  const list = chartData.range.filter((t) => !isIncome(t) && (!state.catFilter || catOf(t.category_id).major === state.catFilter));
  $('#cat-bars').innerHTML = barsHtml(aggregateByCat(list), (c) => `var(--${c.major})`);
}
function renderIncomeBars() {
  $('#income-bars').innerHTML = barsHtml(aggregateByCat(chartData.range.filter(isIncome)), () => 'var(--income)');
}

function renderTrend() {
  const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  const rows = chartData.months.map((d) => ({ d, key: keyOf(d), consumption: 0, waste: 0, investment: 0, income: 0 }));
  const idx = new Map(rows.map((r) => [r.key, r]));
  for (const t of chartData.trend) {
    const r = idx.get(t.date.slice(0, 7));
    if (!r) continue;
    const c = catOf(t.category_id);
    if (c.kind === 'income') r.income += t.amount; else r[c.major] += t.amount;
  }
  const labels = rows.map((r) => `${r.d.getMonth() + 1}月`);
  const surface = cssVar('--surface');
  const lastIdx = MAJORS.length - 1;

  charts.trend?.destroy();
  charts.trend = new Chart($('#chart-trend'), {
    type: 'bar',
    data: {
      labels,
      datasets: MAJORS.map((m, i) => ({
        label: m.label,
        data: rows.map((r) => r[m.key]),
        backgroundColor: cssVar(`--${m.key}`),
        borderColor: surface,
        borderWidth: { top: i === lastIdx ? 0 : 2 },
        borderSkipped: false,
        borderRadius: i === lastIdx ? { topLeft: 4, topRight: 4 } : 0,
        maxBarThickness: 36,
      })),
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { color: cssVar('--text-2') } },
        y: {
          stacked: true, beginAtZero: true, border: { display: false },
          grid: { color: cssVar('--border') },
          ticks: { color: cssVar('--text-3'), callback: (v) => yenShort(v), maxTicksLimit: 6 },
        },
      },
      plugins: {
        legend: {
          position: 'top', align: 'start',
          labels: { color: cssVar('--text-2'), boxWidth: 12, boxHeight: 12, useBorderRadius: true, borderRadius: 3 },
        },
        tooltip: {
          callbacks: {
            label: (c) => ` ${c.dataset.label}: ${yen(c.raw)}`,
            footer: (items) => `支出計: ${yen(items.reduce((a, i) => a + i.raw, 0))}`,
          },
        },
      },
    },
  });

  const sumExp = (r) => r.consumption + r.waste + r.investment;
  $('#trend-table').innerHTML = `
    <thead><tr><th>月</th><th>収入</th><th>消費</th><th>浪費</th><th>投資</th><th>支出計</th><th>収支</th></tr></thead>
    <tbody>${rows.slice().reverse().map((r) => {
      const bal = r.income - sumExp(r);
      return `<tr><td>${fmtMonth(r.d)}</td><td>${yen(r.income)}</td><td>${yen(r.consumption)}</td><td>${yen(r.waste)}</td>
        <td>${yen(r.investment)}</td><td>${yen(sumExp(r))}</td><td class="${bal < 0 ? 'neg' : ''}">${bal < 0 ? '-' : ''}${yen(Math.abs(bal))}</td></tr>`;
    }).join('')}</tbody>`;
}

// =====================================================================
// 画面：設定
// =====================================================================
async function renderSettings() {
  const recurring = await db.listRecurring(state.hh);
  const kind = state.settingsKind;
  const cats = sortedCats(kind, { includeArchived: true });

  const recRow = (r) => {
    const cat = catOf(r.category_id);
    const sub = `${INTERVAL_LABEL[r.interval_months] ?? r.interval_months + 'か月ごと'} ${dayLabel(r.day_of_month)} · ${r.amount_type === 'fixed' ? '固定' : '変動（確認あり）'}`
      + (r.active ? ` · 次回 ${fmtDate(r.next_date)}` : '');
    return `<button type="button" class="row ${r.active ? '' : 'archived'}" data-rec="${r.id}">
      <span class="ic ${toneOf(cat)}">${esc(cat.icon)}</span>
      <span class="body"><span class="title">${esc(r.name)}${r.active ? '' : '<span class="badge gray">停止中</span>'}</span>
        <span class="sub">${esc(sub)}</span></span>
      <span class="amt ${cat.kind === 'income' ? 'income' : ''}">${r.amount_type === 'variable' ? '約' : ''}${yen(r.amount)}</span></button>`;
  };
  const catRow = (c) => `<div class="row ${c.archived ? 'archived' : ''}" data-id="${c.id}">
      <button type="button" class="row-link" data-cat-edit="${c.id}">
        <span class="ic ${toneOf(c)}">${esc(c.icon)}</span>
        <span class="body"><span class="title">${esc(c.name)}${c.archived ? '<span class="badge gray">非表示</span>' : ''}</span></span>
      </button>
      <span class="drag-handle" data-drag aria-label="ドラッグで並べ替え" title="ドラッグで並べ替え">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h16M4 12h16M4 16h16"/></svg></span></div>`;

  const catGroups = kind === 'income'
    ? `<div class="card list" data-sort-list>${cats.map(catRow).join('') || '<p class="empty">カテゴリがありません</p>'}</div>`
    : MAJORS.map((m) => {
      const list = cats.filter((c) => c.major === m.key);
      return `<div class="day-head"><span><span class="dot" style="background:var(--${m.key})"></span> ${m.label}</span></div>
        <div class="card list" data-sort-list>${list.map(catRow).join('') || '<p class="empty">なし</p>'}</div>`;
    }).join('');

  $('#settings').innerHTML = `
    ${state.pending.length ? `<button type="button" class="pending-banner" data-open-pending>🔔 <span>確認待ちが <b>${state.pending.length}件</b> あります</span><span class="arrow">›</span></button>` : ''}
    <div class="settings-head"><h2>固定費・定期収入</h2><button type="button" class="btn small" data-add-rec>＋ 追加</button></div>
    <div class="card list">${recurring.map(recRow).join('') || '<p class="empty">家賃・サブスク・給与など、毎回決まった支払いや入金を登録できます</p>'}</div>

    <div class="settings-head"><h2>カテゴリ</h2><button type="button" class="btn small" data-add-cat>＋ 追加</button></div>
    <div class="segmented block" style="margin-bottom:4px">
      <button type="button" data-skind="expense" aria-pressed="${kind === 'expense'}">支出</button>
      <button type="button" data-skind="income" aria-pressed="${kind === 'income'}">収入</button>
    </div>
    <p class="muted" style="font-size:12px;margin:8px 4px 0">行をタップすると、名前・アイコン・大分類の変更や削除ができます。右端の ≡ をドラッグすると並べ替えられます。</p>
    ${catGroups}

    <div class="settings-head"><h2>アカウント</h2></div>
    <div class="card">
      <label class="field"><span>世帯の名前</span>
        <div style="display:flex;gap:8px"><input name="hhname" value="${esc(state.household?.name ?? '')}" maxlength="30">
        <button type="button" class="btn" data-save-hh>保存</button></div></label>
      <p class="muted" style="font-size:13px;margin:0 0 12px">ログイン中：${esc(state.user.email)}</p>
      <button type="button" class="btn block" data-logout>ログアウト</button>
    </div>`;

  const root = $('#settings');
  if (!root.dataset.dragReady) { enableCategoryDrag(root); root.dataset.dragReady = '1'; }
  const recMap = new Map(recurring.map((r) => [r.id, r]));
  root.onclick = async (e) => {
    const t = e.target;
    if (t.closest('[data-open-pending]')) return openPendingModal();
    if (t.closest('[data-add-rec]')) return openRecurringEditor(null);
    const rec = t.closest('[data-rec]');
    if (rec) return openRecurringEditor(recMap.get(rec.dataset.rec));
    if (t.closest('[data-add-cat]')) return openCategoryEditor(null, state.settingsKind);
    const ce = t.closest('[data-cat-edit]');
    if (ce) return openCategoryEditor(state.catMap.get(ce.dataset.catEdit));
    const sk = t.closest('[data-skind]');
    if (sk) { state.settingsKind = sk.dataset.skind; return renderSettings(); }
    if (t.closest('[data-save-hh]')) {
      const name = $('[name="hhname"]', root).value.trim();
      if (!name) return;
      return guard(async () => { await db.renameHousehold(state.hh, name); state.household.name = name; toast('保存しました'); });
    }
    if (t.closest('[data-logout]')) {
      if (!confirm('ログアウトしますか？')) return;
      await db.signOut();
      location.reload();
    }
  };
}

// 並び順を保存（同じグループ内を 5 刻みで振り直す）
async function saveCategoryOrder(ids) {
  const first = state.catMap.get(ids[0]);
  const base = first.kind === 'income' ? 300 : { consumption: 0, waste: 100, investment: 200 }[first.major];
  const changes = ids.map((id, k) => ({ c: state.catMap.get(id), order: base + (k + 1) * 5 }))
    .filter(({ c, order }) => c.sort_order !== order);
  if (!changes.length) return true;
  await Promise.all(changes.map(({ c, order }) => db.saveCategory({ id: c.id, sort_order: order })));
  changes.forEach(({ c, order }) => { c.sort_order = order; });
  inputMounted = false; // 入力画面の並びも更新
  toast('並び順を保存しました');
  return true;
}

// ≡ をつかんで上下にドラッグ（指でもマウスでも動く）
function enableCategoryDrag(root) {
  root.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('[data-drag]');
    if (!handle || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const row = handle.closest('.row');
    const list = row.closest('[data-sort-list]');
    if (!row || !list) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);

    const before = $$('.row[data-id]', list).map((r) => r.dataset.id);
    let startY = e.clientY + window.scrollY;
    let lastClientY = e.clientY;
    const startClientY = e.clientY;
    let raf = 0;
    row.classList.add('dragging');
    document.body.classList.add('is-dragging');
    navigator.vibrate?.(10);

    const update = () => {
      const pageY = lastClientY + window.scrollY;
      // 上の行の中央を越えたら入れ替え
      let prev = row.previousElementSibling;
      while (prev && prev.matches('.row[data-id]')) {
        const r = prev.getBoundingClientRect();
        if (pageY >= r.top + window.scrollY + r.height / 2) break;
        list.insertBefore(row, prev);
        startY -= r.height;
        prev = row.previousElementSibling;
      }
      // 下の行の中央を越えたら入れ替え
      let next = row.nextElementSibling;
      while (next && next.matches('.row[data-id]')) {
        const r = next.getBoundingClientRect();
        if (pageY <= r.top + window.scrollY + r.height / 2) break;
        list.insertBefore(row, next.nextElementSibling);
        startY += r.height;
        next = row.nextElementSibling;
      }
      row.style.transform = `translateY(${pageY - startY}px)`;
    };
    // 画面の端に来たら自動スクロール
    const autoScroll = () => {
      const navTop = window.innerWidth >= 900 ? window.innerHeight : $('.nav').getBoundingClientRect().top;
      const edge = 70;
      const moved = lastClientY - startClientY; // 指を動かした方向にだけスクロール
      let dy = 0;
      if (moved < -10 && lastClientY < edge) dy = -Math.ceil((edge - lastClientY) / 6);
      else if (moved > 10 && lastClientY > navTop - edge) dy = Math.ceil((lastClientY - (navTop - edge)) / 6);
      if (dy) { window.scrollBy(0, dy); update(); }
      raf = requestAnimationFrame(autoScroll);
    };
    raf = requestAnimationFrame(autoScroll);

    const onMove = (ev) => { lastClientY = ev.clientY; update(); };
    const onEnd = async () => {
      cancelAnimationFrame(raf);
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onEnd);
      handle.removeEventListener('pointercancel', onEnd);
      row.classList.remove('dragging');
      row.style.transform = '';
      document.body.classList.remove('is-dragging');
      const after = $$('.row[data-id]', list).map((r) => r.dataset.id);
      if (after.join() !== before.join()) {
        const ok = await guard(() => saveCategoryOrder(after));
        if (ok === undefined) renderSettings(); // 失敗時は元の並びに戻す
      }
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onEnd);
    handle.addEventListener('pointercancel', onEnd);
  });
}

function openCategoryEditor(cat, defaultKind = 'expense', { major, onSaved } = {}) {
  const s = {
    kind: cat?.kind ?? defaultKind,
    major: cat?.major ?? major ?? 'consumption',
    icon: cat?.icon ?? (defaultKind === 'income' ? '💴' : '🛒'),
  };
  const body = openModal(cat ? 'カテゴリの編集' : 'カテゴリの追加', `
    <form novalidate>
      ${cat ? '' : `<div class="field"><span>種別</span><div class="segmented block kind">
        <button type="button" data-kind="expense">支出</button><button type="button" data-kind="income">収入</button></div></div>`}
      <div class="field" data-major-field><span>大分類</span><div class="segmented block">
        ${MAJORS.map((m) => `<button type="button" data-major="${m.key}">${m.label}</button>`).join('')}</div></div>
      <label class="field"><span>名前</span><input name="name" maxlength="30" required value="${esc(cat?.name ?? '')}" placeholder="例：コンビニ"></label>
      <div class="field"><span>アイコン</span>
        <div class="emoji-preview"><span class="ic" data-preview></span>
          <input name="icon" maxlength="8" value="${esc(s.icon)}" aria-label="アイコン（絵文字を直接入力も可）" style="min-height:44px;padding:10px 12px;border-radius:10px;border:1px solid var(--border);background:var(--surface);font-size:22px;width:100%"></div>
        <div class="hint">下から選ぶか、絵文字を直接入力できます</div>
        <div class="emoji-grid">${EMOJIS.map((em) => `<button type="button" data-emoji="${em}">${em}</button>`).join('')}</div>
      </div>
      ${cat ? `<label class="switch-row">入力画面に表示しない（非表示）<input type="checkbox" name="archived" ${cat.archived ? 'checked' : ''}></label>` : ''}
      <div class="modal-foot">
        ${cat ? '<button type="button" class="btn danger" data-del>削除</button>' : ''}
        <button type="submit" class="btn primary">保存</button>
      </div>
    </form>`);
  const form = $('form', body);
  const render = () => {
    $$('[data-kind]', form).forEach((b) => b.setAttribute('aria-pressed', b.dataset.kind === s.kind));
    $$('[data-major]', form).forEach((b) => b.setAttribute('aria-pressed', b.dataset.major === s.major));
    $('[data-major-field]', form).hidden = s.kind !== 'expense';
    const p = $('[data-preview]', form);
    p.className = `ic ${s.kind === 'income' ? 'income' : s.major}`;
    p.textContent = s.icon || '📁';
    $$('[data-emoji]', form).forEach((b) => b.setAttribute('aria-pressed', b.dataset.emoji === s.icon));
  };
  form.icon.addEventListener('input', () => { s.icon = form.icon.value.trim(); render(); });
  form.addEventListener('click', async (e) => {
    const k = e.target.closest('[data-kind]'); if (k) { s.kind = k.dataset.kind; render(); return; }
    const m = e.target.closest('[data-major]'); if (m) { s.major = m.dataset.major; render(); return; }
    const em = e.target.closest('[data-emoji]'); if (em) { s.icon = em.dataset.emoji; form.icon.value = s.icon; render(); return; }
    if (e.target.closest('[data-del]')) {
      if (!confirm(`カテゴリ「${cat.name}」を削除しますか？`)) return;
      await guard(async () => {
        const ok = await db.deleteCategory(cat.id);
        if (!ok) {
          if (!confirm('このカテゴリは記録や固定費で使われているため削除できません。\n代わりに非表示にしますか？（過去の記録はそのまま残ります）')) return;
          await db.saveCategory({ id: cat.id, archived: true });
          toast('非表示にしました');
        } else {
          toast('削除しました');
        }
        setCategories(await db.listCategories(state.hh));
        closeModal(); inputMounted = false; renderView();
      });
    }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = form.name.value.trim();
    if (!name) { toast('名前を入力してください', true); return; }
    const row = {
      name,
      icon: s.icon || '📁',
      kind: s.kind,
      major: s.kind === 'expense' ? s.major : null,
    };
    if (cat) {
      row.id = cat.id;
      row.archived = form.archived.checked;
      if (cat.kind !== s.kind || cat.major !== row.major) {
        row.sort_order = (s.kind === 'income' ? 300 : { consumption: 0, waste: 100, investment: 200 }[s.major]) + 99;
      }
    } else {
      row.household_id = state.hh;
      const group = sortedCats(s.kind, { includeArchived: true }).filter((c) => c.major === row.major);
      row.sort_order = group.length ? Math.max(...group.map((c) => c.sort_order)) + 5
        : (s.kind === 'income' ? 300 : { consumption: 0, waste: 100, investment: 200 }[s.major]) + 5;
    }
    await guard(async () => {
      const saved = await db.saveCategory(row);
      setCategories(await db.listCategories(state.hh));
      closeModal();
      if (onSaved) { toast(`${row.icon} ${row.name} を追加しました`); onSaved(saved); return; }
      toast('保存しました'); inputMounted = false; renderView();
    });
  });
  render();
}

function openRecurringEditor(rec) {
  const now = firstOfMonth(new Date());
  const startBase = rec ? firstOfMonth(parseYmd(rec.next_date)) : now;
  const s = {
    kind: rec ? catOf(rec.category_id).kind : 'expense',
    amountType: rec?.amount_type ?? 'fixed',
  };
  // 開始月の選択肢：12か月前〜24か月後（編集時は次回月も必ず含む）
  const monthOpts = [];
  for (let i = -12; i <= 24; i++) monthOpts.push(addMonths(now, i));
  if (!monthOpts.some((d) => d.getTime() === startBase.getTime())) monthOpts.push(startBase);
  monthOpts.sort((a, b) => a - b);

  const body = openModal(rec ? '固定費の編集' : '固定費・定期収入の追加', `
    <form novalidate>
      <div class="field"><span>種別</span><div class="segmented block kind">
        <button type="button" data-kind="expense">支出</button><button type="button" data-kind="income">収入</button></div></div>
      <label class="field"><span>カテゴリ</span><select name="category"></select></label>
      <label class="field"><span>名前</span><input name="name" maxlength="30" value="${esc(rec?.name ?? '')}" placeholder="例：家賃、水道代、給与"></label>
      <div class="field"><span>金額のタイプ</span><div class="segmented block">
        <button type="button" data-atype="fixed">固定</button><button type="button" data-atype="variable">変動（確認あり）</button></div>
        <div class="hint" data-atype-hint></div></div>
      <label class="field"><span data-amount-label>金額</span><input name="amount" inputmode="numeric" value="${rec ? rec.amount.toLocaleString('ja-JP') : ''}" placeholder="0"></label>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <label class="field"><span>頻度</span><select name="interval">
          ${INTERVALS.map(([v, l]) => `<option value="${v}" ${(rec?.interval_months ?? 1) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="field"><span>日付</span><select name="day">
          ${Array.from({ length: 31 }, (_, i) => i + 1).map((d) => `<option value="${d}" ${(rec?.day_of_month ?? 1) === d ? 'selected' : ''}>${dayLabel(d)}</option>`).join('')}</select></label>
      </div>
      <label class="field"><span>${rec ? '次回の月' : '最初の月'}</span><select name="start">
        ${monthOpts.map((d) => `<option value="${ymd(d)}" ${d.getTime() === startBase.getTime() ? 'selected' : ''}>${fmtMonth(d)}</option>`).join('')}</select></label>
      <div class="preview-box" data-preview></div>
      ${rec ? `<label class="switch-row">有効（オフにすると記録を停止）<input type="checkbox" name="active" ${rec.active ? 'checked' : ''}></label>` : ''}
      <div class="modal-foot">
        ${rec ? '<button type="button" class="btn danger" data-del>削除</button>' : ''}
        <button type="submit" class="btn primary">保存</button>
      </div>
    </form>`);
  const form = $('form', body);
  bindAmountInput(form.amount);

  const fillCats = (keep) => {
    const cats = sortedCats(s.kind);
    if (keep) { const cur = state.catMap.get(keep); if (cur && cur.kind === s.kind && !cats.includes(cur)) cats.push(cur); }
    const opt = (c) => `<option value="${c.id}" ${c.id === keep ? 'selected' : ''}>${esc(c.icon)} ${esc(c.name)}</option>`;
    form.category.innerHTML = '<option value="">選んでください</option>' + (s.kind === 'income'
      ? cats.map(opt).join('')
      : MAJORS.map((m) => `<optgroup label="${m.label}">${cats.filter((c) => c.major === m.key).map(opt).join('')}</optgroup>`).join(''));
  };
  const nextDate = () => monthDay(parseYmd(form.start.value), Number(form.day.value));
  const render = () => {
    $$('[data-kind]', form).forEach((b) => b.setAttribute('aria-pressed', b.dataset.kind === s.kind));
    $$('[data-atype]', form).forEach((b) => b.setAttribute('aria-pressed', b.dataset.atype === s.amountType));
    $('[data-atype-hint]', form).textContent = s.amountType === 'fixed'
      ? '毎回同じ金額で自動的に記録されます（家賃・サブスクなど）'
      : '予定金額で「確認待ち」になり、実際の金額を入れて確定します（電気・水道など）';
    $('[data-amount-label]', form).textContent = s.amountType === 'fixed' ? '金額' : '予定金額（目安）';
    const nd = ymd(nextDate());
    const interval = Number(form.interval.value);
    let html = `次回 <b>${esc(fmtDateLong(nd))}</b> に記録、以降 <b>${esc(INTERVAL_LABEL[interval])}</b>`;
    if (nd <= todayStr() && (!rec || form.active?.checked)) {
      html += '<br>※ 今日以前の日付のため、保存するとすぐにその分が記録されます';
    }
    $('[data-preview]', form).innerHTML = html;
  };

  form.addEventListener('click', async (e) => {
    const k = e.target.closest('[data-kind]');
    if (k) { s.kind = k.dataset.kind; fillCats(null); render(); return; }
    const a = e.target.closest('[data-atype]');
    if (a) { s.amountType = a.dataset.atype; render(); return; }
    if (e.target.closest('[data-del]')) {
      if (!confirm(`「${rec.name}」を削除しますか？\n（これまでに記録された分は残ります）`)) return;
      await guard(async () => {
        await db.deleteRecurring(rec.id);
        closeModal(); toast('削除しました'); renderSettings();
      });
    }
  });
  form.addEventListener('change', (e) => {
    if (e.target === form.category && !form.name.value.trim()) {
      const c = state.catMap.get(form.category.value);
      if (c) form.name.value = c.name;
    }
    render();
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = form.name.value.trim();
    const amount = parseAmount(form.amount.value);
    if (!form.category.value) { toast('カテゴリを選んでください', true); return; }
    if (!name) { toast('名前を入力してください', true); return; }
    if (s.amountType === 'fixed' && !amount) { toast('金額を入力してください', true); return; }
    const row = {
      category_id: form.category.value,
      name,
      amount,
      amount_type: s.amountType,
      interval_months: Number(form.interval.value),
      day_of_month: Number(form.day.value),
      next_date: ymd(nextDate()),
    };
    if (rec) { row.id = rec.id; row.active = form.active.checked; } else { row.household_id = state.hh; }
    await guard(async () => {
      await db.saveRecurring(row);
      const n = await db.processRecurring(state.hh);
      closeModal();
      toast(n ? `保存しました（${n}件を記録）` : '保存しました');
      await loadPending();
      renderSettings();
    });
  });

  fillCats(rec?.category_id ?? null);
  render();
}

// =====================================================================
// 画面切替
// =====================================================================
async function renderView() {
  $$('.nav-item').forEach((b) => (b.dataset.view === state.view ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
  $$('.view').forEach((v) => { v.hidden = v.id !== `view-${state.view}`; });
  await guard(async () => {
    if (state.view === 'input') await renderInput();
    else if (state.view === 'history') await renderHistory();
    else if (state.view === 'charts') await renderCharts();
    else if (state.view === 'settings') await renderSettings();
  });
}
$$('.nav-item').forEach((b) => b.addEventListener('click', () => {
  state.view = b.dataset.view;
  window.scrollTo(0, 0);
  renderView();
}));

async function refreshAfterChange(rerender = true) {
  await loadPending();
  if (rerender) await renderView();
  else if (state.view !== 'input') await renderView();
}

// 画面に戻ってきたとき（スマホでアプリを再表示したとき）に最新化
let lastSync = Date.now();
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !state.hh || Date.now() - lastSync < 30000) return;
  lastSync = Date.now();
  await guard(async () => {
    setCategories(await db.listCategories(state.hh));
    const n = await db.processRecurring(state.hh);
    if (n) toast(`固定費を${n}件記録しました`);
    await loadPending();
    if (modal.open) return;
    // 入力画面は入力途中の内容を消さないよう、一覧だけ更新
    if (state.view === 'input') await loadRecent(); else await renderView();
  });
});
// ダーク/ライト切替時にグラフの色を更新
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (state.view === 'charts') renderCharts(); });

// =====================================================================
// 起動
// =====================================================================
async function startApp(user) {
  state.user = user;
  state.hh = await db.ensureHousehold();
  const [household, categories] = await Promise.all([db.getHousehold(state.hh), db.listCategories(state.hh)]);
  state.household = household;
  setCategories(categories);
  const n = await guard(() => db.processRecurring(state.hh));
  await loadPending();
  $('#splash').hidden = true;
  $('#login').hidden = true;
  $('#app').hidden = false;
  await renderView();
  if (n) toast(`固定費を${n}件記録しました`);
}

function showLogin() {
  $('#splash').hidden = true;
  $('#login').hidden = false;
  const form = $('#login-form');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = $('button', form);
    const err = $('#login-error');
    btn.disabled = true; err.hidden = true;
    try {
      await db.signIn(form.email.value.trim(), form.password.value);
      await startApp(await db.getUser());
    } catch (ex) {
      err.textContent = errMsg(ex); err.hidden = false;
    } finally {
      btn.disabled = false;
    }
  };
}

async function boot() {
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  try {
    const user = await db.getUser();
    if (user) await startApp(user); else showLogin();
  } catch (e) {
    console.error(e);
    $('#splash').textContent = errMsg(e);
  }
}
boot();
