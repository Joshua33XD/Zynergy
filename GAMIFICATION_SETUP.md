# Gamification Setup

## 1) Apply schema
- Open Supabase SQL editor.
- Run `gamification_schema.sql`.

## 2) What is now powered
- Daily missions with completion bonus.
- Weekly quest progress.
- Badge unlock UI.
- Leaderboard rival and rank-change indicator.
- XP event logging (`xp_events`) for anti-abuse analysis and reward audits.

## 3) Optional server hardening
- Add a Supabase Edge Function to validate XP grants and rate-limit per source.
- Move all XP writes to server-side function if strict anti-cheat is required.

## 4) Weekly rank snapshots
- `weekly_rank_snapshots` table is created for trend tracking.
- You can populate it with a scheduled job once a week.
