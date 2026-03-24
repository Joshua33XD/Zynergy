-- Gamification schema for ZYNERGY
-- Run in Supabase SQL editor.

create table if not exists xp_events (
  id bigserial primary key,
  user_id uuid not null,
  username text,
  event_date date not null default current_date,
  xp_delta integer not null,
  source text not null default 'general',
  created_at timestamptz not null default now()
);

create index if not exists idx_xp_events_user_date
  on xp_events (user_id, event_date desc);

create table if not exists user_badges (
  id bigserial primary key,
  user_id uuid not null,
  badge_key text not null,
  awarded_at timestamptz not null default now(),
  unique (user_id, badge_key)
);

create table if not exists weekly_rank_snapshots (
  id bigserial primary key,
  week_start date not null,
  user_id uuid not null,
  rank integer not null,
  best_score numeric not null default 0,
  created_at timestamptz not null default now(),
  unique (week_start, user_id)
);

alter table xp_events enable row level security;
alter table user_badges enable row level security;
alter table weekly_rank_snapshots enable row level security;

drop policy if exists xp_events_select_own on xp_events;
create policy xp_events_select_own on xp_events
for select using (auth.uid() = user_id);

drop policy if exists xp_events_insert_own on xp_events;
create policy xp_events_insert_own on xp_events
for insert with check (auth.uid() = user_id);

drop policy if exists user_badges_select_own on user_badges;
create policy user_badges_select_own on user_badges
for select using (auth.uid() = user_id);

drop policy if exists user_badges_insert_own on user_badges;
create policy user_badges_insert_own on user_badges
for insert with check (auth.uid() = user_id);

drop policy if exists weekly_rank_snapshots_select_all on weekly_rank_snapshots;
create policy weekly_rank_snapshots_select_all on weekly_rank_snapshots
for select using (true);
