# Database Setup Guide

This guide explains how to set up the database schema and RLS policies for the daily tracking application.

## Step 1: Add Username Column to Tables

Run the SQL migration file `add_username_migration.sql` in your Supabase SQL Editor:

```sql
-- This adds the username column to all three tables:
-- workout_daily, daily_sleep, daily_nutrition
```

**Location:** Supabase Dashboard → SQL Editor → Run `add_username_migration.sql`

## Step 2: Enable Row Level Security (RLS)

For each table, enable RLS:

1. Go to **Table Editor** in Supabase
2. Select each table: `workout_daily`, `daily_sleep`, `daily_nutrition`
3. Click **Settings** → Enable **Row Level Security**

## Step 3: Create RLS Policies

Run the SQL file `rls_policies.sql` in your Supabase SQL Editor:

```sql
-- This creates INSERT, UPDATE, and SELECT policies for all three tables
-- Policies ensure users can only access their own data (auth.uid() = user_id)
```

**Location:** Supabase Dashboard → SQL Editor → Run `rls_policies.sql`

## Step 4: Verify Tables Have Username Column

After running the migration, verify each table has a `username` column:

- `workout_daily.username` (text, nullable)
- `daily_sleep.username` (text, nullable)
- `daily_nutrition.username` (text, nullable)

## Summary of Changes

### Code Changes:
- ✅ Added `getUserInfo()` helper function to get user_id and username from session
- ✅ Added `upsertWithFallback()` helper function for consistent upsert logic
- ✅ Added `handleError()` helper function for consistent error handling
- ✅ Updated `getValues()` to include username field
- ✅ Created `saveSleepData()` function for sleep tracking
- ✅ Created `saveNutritionData()` function for nutrition tracking
- ✅ Updated HTML files to connect forms to JavaScript functions

### Database Schema:
- ✅ Added `username` column to `workout_daily`
- ✅ Added `username` column to `daily_sleep`
- ✅ Added `username` column to `daily_nutrition`

### RLS Policies:
- ✅ INSERT policies for all tables
- ✅ UPDATE policies for all tables
- ✅ SELECT policies for all tables

## Testing

After setup, test each form:

1. **Workouts** (`workouts.html`): Select intensity, muscle groups, energy level → Submit
2. **Sleep** (`sleep.html`): Enter hours slept, select emoji → Save Sleep Data
3. **Nutrition** (`nutrition.html`): Fill meals, check goals, add notes → Submit

All forms should:
- Check authentication before saving
- Include username in database records
- Handle duplicate entries (upsert)
- Show clear error messages if RLS or validation fails
