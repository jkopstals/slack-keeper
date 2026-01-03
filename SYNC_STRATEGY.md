# Slack Archiver - Optimized Polling Strategy

## Overview

This sync script uses an intelligent polling strategy optimized for low-traffic channels that automatically handles:
- ✅ New messages
- ✅ Thread replies (including replies to old messages)
- ✅ Message edits
- ✅ Efficient re-checking to minimize API calls

## How It Works

### Sync Modes

**1. FULL SYNC (First run of the day)**
- Re-checks ALL available history (up to 90 days on Slack free tier)
- Fetches all messages and their threads
- Updates any edited messages
- Records completion in `sync_log` table

**2. INCREMENTAL SYNC (Subsequent runs same day)**
- Re-checks last X days (default: 3) for edits and new replies to old threads
- Fetches any truly new messages beyond the last sync
- Much faster than full sync

### Configuration

Set these environment variables to customize behavior:

```bash
RECHECK_DAYS=3           # Days to re-check for edits/replies (default: 3)
FULL_SYNC_DAYS=90        # Max history to sync on full sync (default: 90)
```

### Example Scenarios

#### Scenario 1: Someone replies to a week-old message
- **First hourly run of the day** (FULL SYNC):
  - Re-checks all history, finds the new reply ✅
  
- **Subsequent hourly runs** (INCREMENTAL):
  - If reply was added within last 3 days: Found ✅
  - If reply was added >3 days ago: Wait until tomorrow's full sync

#### Scenario 2: Someone edits a message from yesterday
- **Any run**: Message is within the 3-day recheck window, edit is captured ✅

#### Scenario 3: New message posted
- **Any run**: New messages are always fetched immediately ✅

## Database Schema

### sync_log Table
Tracks daily sync operations:

```sql
CREATE TABLE sync_log (
  sync_date DATE PRIMARY KEY,              -- YYYY-MM-DD
  completed_at TIMESTAMPTZ NOT NULL,       -- When sync finished
  total_messages INTEGER NOT NULL,         -- New messages synced
  total_replies INTEGER NOT NULL,          -- Replies synced
  channels_processed INTEGER NOT NULL,     -- Channels processed
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### messages Table (Updated)
Added `edited_timestamp` to track edits:

```sql
ALTER TABLE messages 
ADD COLUMN edited_timestamp TIMESTAMPTZ;
```

## GitHub Actions Schedule

With hourly runs, the typical pattern is:

```
00:59 - FULL SYNC (re-checks all history)
01:59 - INCREMENTAL (last 3 days + new)
02:59 - INCREMENTAL (last 3 days + new)
...
23:59 - INCREMENTAL (last 3 days + new)
```

Next day:
```
00:59 - FULL SYNC (re-checks all history)
...
```

## Performance Considerations

### Low-Traffic Channel (Recommended Settings)
```bash
RECHECK_DAYS=3           # Catches most late replies/edits
```
- ~1-2 API calls per channel per incremental sync
- Full sync once daily ensures nothing is missed

### Medium-Traffic Channel
```bash
RECHECK_DAYS=7           # More thorough checking
```
- More API calls, but still reasonable for hourly runs

### High-Traffic Channel
Consider:
- Implementing webhooks instead of polling
- Or increasing RECHECK_DAYS and accepting some delay in edit detection

## Trade-offs

### Why Not Check Everything Every Time?
- ❌ Wastes API calls
- ❌ Slower syncs
- ❌ Risk of hitting rate limits

### Why Not Just Fetch New Messages?
- ❌ Misses replies to old threads
- ❌ Misses message edits
- ❌ Incomplete archive

### This Optimized Approach:
- ✅ Balances completeness with efficiency
- ✅ Guarantees daily full sync for completeness
- ✅ Quick incremental syncs catch 99% of activity
- ✅ Configurable for your specific needs

## Monitoring

Check sync_log to monitor performance:

```sql
-- Recent sync activity
SELECT 
  sync_date,
  completed_at,
  total_messages,
  total_replies,
  channels_processed
FROM sync_log
ORDER BY sync_date DESC
LIMIT 7;

-- Average messages per day
SELECT 
  AVG(total_messages) as avg_messages_per_day,
  AVG(total_replies) as avg_replies_per_day
FROM sync_log
WHERE sync_date >= CURRENT_DATE - INTERVAL '30 days';
```

## Installation

1. Run the schema updates:
```bash
psql $DATABASE_URL < schema-updates.sql
```

2. Update your GitHub Actions workflow to use the new script
3. Set environment variables if you want non-default values
4. First run will be a full sync!