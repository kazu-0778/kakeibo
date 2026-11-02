-- =====================================================================
-- 家計簿アプリ データベース定義
-- Supabase の SQL Editor に全文を貼り付けて「Run」を押してください。
-- 何度実行しても壊れないように作ってあります（既存データは消えません）。
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. テーブル
-- ---------------------------------------------------------------------

-- 世帯（家族共有の単位）
create table if not exists public.households (
  id         uuid primary key default gen_random_uuid(),
  name       text not null default 'わが家',
  created_at timestamptz not null default now()
);

-- 世帯メンバー（将来、家族のアカウントをここに追加すると共有されます）
create table if not exists public.household_members (
  household_id uuid not null references public.households(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  role         text not null default 'member' check (role in ('owner', 'member')),
  display_name text,
  created_at   timestamptz not null default now(),
  primary key (household_id, user_id)
);

-- カテゴリ
--   kind : expense（支出） / income（収入）
--   major: consumption（消費） / waste（浪費） / investment（投資）※支出のみ
create table if not exists public.categories (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  kind         text not null check (kind in ('expense', 'income')),
  major        text check (major in ('consumption', 'waste', 'investment')),
  name         text not null check (char_length(name) between 1 and 30),
  icon         text not null default '📁',
  sort_order   integer not null default 0,
  archived     boolean not null default false,
  created_at   timestamptz not null default now(),
  unique (id, household_id),
  check ((kind = 'expense' and major is not null) or (kind = 'income' and major is null))
);

-- 固定費・定期収入
--   amount_type   : fixed（金額固定・自動で確定） / variable（変動・確認待ちになる）
--   interval_months: 1=毎月, 2=2か月ごと, 3, 6, 12
--   day_of_month  : 1〜31（31 は月末扱い）
--   next_date     : 次に記録される日
create table if not exists public.recurring_items (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null references public.households(id) on delete cascade,
  category_id     uuid not null,
  name            text not null check (char_length(name) between 1 and 30),
  amount          integer not null check (amount >= 0),
  amount_type     text not null default 'fixed' check (amount_type in ('fixed', 'variable')),
  interval_months integer not null default 1 check (interval_months between 1 and 12),
  day_of_month    integer not null check (day_of_month between 1 and 31),
  next_date       date not null,
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  foreign key (category_id, household_id) references public.categories(id, household_id)
);

-- 収支の記録
--   status: confirmed（確定） / pending（確認待ち：変動の固定費）
create table if not exists public.transactions (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  category_id  uuid not null,
  amount       integer not null check (amount >= 0),
  date         date not null,
  memo         text,
  status       text not null default 'confirmed' check (status in ('confirmed', 'pending')),
  recurring_id uuid references public.recurring_items(id) on delete set null,
  created_by   uuid references auth.users(id) on delete set null default auth.uid(),
  created_at   timestamptz not null default now(),
  foreign key (category_id, household_id) references public.categories(id, household_id),
  unique (recurring_id, date)   -- 固定費の二重登録防止
);

create index if not exists transactions_household_date_idx on public.transactions (household_id, date);
create index if not exists transactions_pending_idx on public.transactions (household_id) where status = 'pending';
create index if not exists categories_household_idx on public.categories (household_id);
create index if not exists recurring_household_idx on public.recurring_items (household_id);
create index if not exists members_user_idx on public.household_members (user_id);

-- ---------------------------------------------------------------------
-- 2. アクセス制御（自分の世帯のデータだけ読み書きできる）
-- ---------------------------------------------------------------------

create or replace function public.is_member(h uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.household_members
    where household_id = h and user_id = auth.uid()
  );
$$;

alter table public.households        enable row level security;
alter table public.household_members enable row level security;
alter table public.categories        enable row level security;
alter table public.recurring_items   enable row level security;
alter table public.transactions      enable row level security;

drop policy if exists households_select on public.households;
create policy households_select on public.households
  for select to authenticated using (public.is_member(id));
drop policy if exists households_update on public.households;
create policy households_update on public.households
  for update to authenticated using (public.is_member(id)) with check (public.is_member(id));

drop policy if exists members_select on public.household_members;
create policy members_select on public.household_members
  for select to authenticated using (public.is_member(household_id));

drop policy if exists categories_all on public.categories;
create policy categories_all on public.categories
  for all to authenticated
  using (public.is_member(household_id)) with check (public.is_member(household_id));

drop policy if exists recurring_all on public.recurring_items;
create policy recurring_all on public.recurring_items
  for all to authenticated
  using (public.is_member(household_id)) with check (public.is_member(household_id));

drop policy if exists transactions_all on public.transactions;
create policy transactions_all on public.transactions
  for all to authenticated
  using (public.is_member(household_id)) with check (public.is_member(household_id));

grant usage on schema public to authenticated;
grant select, update on public.households to authenticated;
grant select on public.household_members to authenticated;
grant select, insert, update, delete on public.categories, public.recurring_items, public.transactions to authenticated;

-- ---------------------------------------------------------------------
-- 3. 関数
-- ---------------------------------------------------------------------

-- 指定月の day 日（その月に無ければ月末）を返す
create or replace function public.month_day(base date, d integer)
returns date
language sql immutable
as $$
  select least(
    (date_trunc('month', base)::date + (d - 1)),
    (date_trunc('month', base) + interval '1 month - 1 day')::date
  );
$$;

-- ログインユーザーの世帯を返す。無ければ作成し、初期カテゴリを入れる。
create or replace function public.ensure_household()
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_hh  uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  select household_id into v_hh
  from public.household_members
  where user_id = v_uid
  order by created_at
  limit 1;

  if v_hh is not null then
    return v_hh;
  end if;

  insert into public.households (name) values ('わが家') returning id into v_hh;
  insert into public.household_members (household_id, user_id, role) values (v_hh, v_uid, 'owner');

  insert into public.categories (household_id, kind, major, name, icon, sort_order) values
    (v_hh, 'expense', 'consumption', '食費',     '🍙', 10),
    (v_hh, 'expense', 'consumption', '日用品',   '🧴', 20),
    (v_hh, 'expense', 'consumption', '住居',     '🏠', 30),
    (v_hh, 'expense', 'consumption', '電気',     '💡', 40),
    (v_hh, 'expense', 'consumption', 'ガス',     '🔥', 50),
    (v_hh, 'expense', 'consumption', '水道',     '🚰', 60),
    (v_hh, 'expense', 'consumption', '通信',     '📱', 70),
    (v_hh, 'expense', 'consumption', '交通',     '🚃', 80),
    (v_hh, 'expense', 'consumption', '医療',     '🏥', 90),
    (v_hh, 'expense', 'waste',       '外食',     '🍜', 110),
    (v_hh, 'expense', 'waste',       '飲み会',   '🍺', 120),
    (v_hh, 'expense', 'waste',       '趣味',     '🎮', 130),
    (v_hh, 'expense', 'waste',       '衝動買い', '🛍️', 140),
    (v_hh, 'expense', 'investment',  '積立投資', '📈', 210),
    (v_hh, 'expense', 'investment',  '自己投資', '📚', 220),
    (v_hh, 'expense', 'investment',  '貯金',     '🐷', 230),
    (v_hh, 'income',  null,          '給与',     '💴', 310),
    (v_hh, 'income',  null,          '賞与',     '💰', 320),
    (v_hh, 'income',  null,          '副業',     '💼', 330),
    (v_hh, 'income',  null,          '臨時収入', '🎁', 340);

  return v_hh;
end;
$$;

-- 期日が来た固定費を記録する（アプリを開いたときに呼ばれる）
--   fixed    → 確定として記録
--   variable → 確認待ちとして記録（予定額が入る）
-- 何度呼んでも、複数端末から同時に呼んでも二重にはなりません。
create or replace function public.process_recurring(p_household uuid)
returns integer
language plpgsql security invoker set search_path = public
as $$
declare
  r       record;
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
  v_next  date;
  v_count integer := 0;
  v_rows  integer;
begin
  if not public.is_member(p_household) then
    raise exception 'forbidden';
  end if;

  for r in
    select * from public.recurring_items
    where household_id = p_household and active and next_date <= v_today
    for update
  loop
    v_next := r.next_date;
    while v_next <= v_today loop
      insert into public.transactions
        (household_id, category_id, amount, date, memo, status, recurring_id)
      values
        (r.household_id, r.category_id, r.amount, v_next, r.name,
         case when r.amount_type = 'fixed' then 'confirmed' else 'pending' end, r.id)
      on conflict (recurring_id, date) do nothing;
      get diagnostics v_rows = row_count;
      v_count := v_count + v_rows;
      v_next := public.month_day(
        (date_trunc('month', v_next) + make_interval(months => r.interval_months))::date,
        r.day_of_month);
    end loop;
    update public.recurring_items set next_date = v_next where id = r.id;
  end loop;

  return v_count;
end;
$$;

revoke all on function public.ensure_household() from public, anon;
revoke all on function public.process_recurring(uuid) from public, anon;
revoke all on function public.is_member(uuid) from public, anon;
grant execute on function public.ensure_household() to authenticated;
grant execute on function public.process_recurring(uuid) to authenticated;
grant execute on function public.is_member(uuid) to authenticated;
grant execute on function public.month_day(date, integer) to authenticated;
