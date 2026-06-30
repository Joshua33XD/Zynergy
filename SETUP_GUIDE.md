# Database Setup Guide

This guide reflects the files that actually exist in this repo.

The repo does **not** currently include `add_username_migration.sql` or `rls_policies.sql`.
The only SQL file present here is `gamification_schema.sql`, which is separate from the core daily tracking tables.

## Core Tracking Tables

The app expects these Supabase tables to exist:

- `workout_daily`
- `daily_sleep`
- `daily_nutrition`

At minimum, those tables should include a `user_id` column and the date columns used by the app:

- `workout_daily.date`
- `daily_sleep.Date`
- `daily_nutrition.entry_date`

The current frontend also writes a `username` column to all three tables.

## Add Missing `username` Columns

Run this in the Supabase SQL Editor if the columns are missing:

```sql
alter table public.workout_daily
add column if not exists username text;

alter table public.daily_sleep
add column if not exists username text;

alter table public.daily_nutrition
add column if not exists username text;
```

## Enable Row Level Security

Run:

```sql
alter table public.workout_daily enable row level security;
alter table public.daily_sleep enable row level security;
alter table public.daily_nutrition enable row level security;
```

## Create Basic Per-User Policies

These policies let authenticated users read and write only their own rows.

```sql
create policy "workout_daily_select_own"
on public.workout_daily
for select
using (auth.uid() = user_id);

create policy "workout_daily_insert_own"
on public.workout_daily
for insert
with check (auth.uid() = user_id);

create policy "workout_daily_update_own"
on public.workout_daily
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "daily_sleep_select_own"
on public.daily_sleep
for select
using (auth.uid() = user_id);

create policy "daily_sleep_insert_own"
on public.daily_sleep
for insert
with check (auth.uid() = user_id);

create policy "daily_sleep_update_own"
on public.daily_sleep
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "daily_nutrition_select_own"
on public.daily_nutrition
for select
using (auth.uid() = user_id);

create policy "daily_nutrition_insert_own"
on public.daily_nutrition
for insert
with check (auth.uid() = user_id);

create policy "daily_nutrition_update_own"
on public.daily_nutrition
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);
```

If policies with those names already exist, skip them or drop/recreate them in Supabase.

## Profile & Sleep Table Schema Updates

Run this in the Supabase SQL Editor to support profile picture, body details, friends, and detailed sleep logging:

```sql
-- Profile details migrations
alter table public.user_profile
add column if not exists avatar_url text,
add column if not exists height numeric,
add column if not exists weight numeric,
add column if not exists age integer,
add column if not exists goal text,
add column if not exists activity_level text,
add column if not exists friends text[];

-- Sleep details migrations
alter table public.daily_sleep
add column if not exists start_time text,
add column if not exists end_time text,
add column if not exists wake_ups integer,
add column if not exists naps boolean,
add column if not exists caffeine boolean,
add column if not exists workout boolean,
add column if not exists subjective_rating text;
```

## Verify Required Columns

Check that these exist:

- `workout_daily.user_id`
- `workout_daily.username`
- `workout_daily.date`
- `daily_sleep.user_id`
- `daily_sleep.username`
- `daily_sleep.Date`
- `daily_nutrition.user_id`
- `daily_nutrition.username`
- `daily_nutrition.entry_date`

## Testing

After setup, test each page:

1. `workouts.html`
2. `sleep.html`
3. `nutrition.html`

All saves should:

- require authentication
- attach `user_id` and `username`
- update the current day when the same user saves again
- fail with a clear RLS error if policies are misconfigured

## AI Meal Scan Backend

The nutrition page now includes an AI meal scan flow that uploads a meal photo to the local Flask backend, detects foods with LogMeal, and resolves nutrition with API Ninjas or Open Food Facts.

### Required environment variables

- `LOGMEAL_API_TOKEN` or `LOGMEAL_TOKEN`
- `API_NINJAS_API_KEY`

### Optional environment variables

- `LOGMEAL_API_BASE` defaults to `https://api.logmeal.com`
- `LOGMEAL_SEGMENTATION_PATH` defaults to `/v2/image/segmentation/complete`
- `OPENFOODFACTS_API_BASE` defaults to `https://world.openfoodfacts.org`
- `API_NINJAS_API_BASE` defaults to `https://api.api-ninjas.com`
- `FOOD_API_TIMEOUT` defaults to `30`

### Run the backend

```bash
python backend.py
```

The frontend expects the backend at `http://127.0.0.1:8000`.
