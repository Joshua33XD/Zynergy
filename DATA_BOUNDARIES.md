# Data Boundaries

This document defines which data belongs in Supabase and which can remain local-only.

## Supabase (DB-backed, cross-device)
- `user_profile`: account profile, XP, level context.
- `workout_daily`: daily workout logs.
- `daily_sleep`: daily sleep logs.
- `daily_nutrition`: daily nutrition logs.
- `workout_challenges`: leaderboard submissions.

Use DB storage for any feature that must sync between devices or support rankings/history.

## Local Storage (device-only)
- `zynergyTheme`: theme preference.
- `lastWorkoutPreset`: convenience preset for local form autofill.

Use local storage only for UX convenience, never as source-of-truth for progress.

## External API (ephemeral read)
- Wger ingredient search results are fetched on-demand and not persisted as source-of-truth.

## Python ML Scope
- `model.py` remains part of the app's ML pipeline (dataset prep/training/detection).
- `backend.py` is reserved for future server-side inference endpoints if/when needed.

