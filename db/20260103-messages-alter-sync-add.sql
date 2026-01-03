-- Add edited_timestamp column to messages table (if not exists)
ALTER TABLE messages 
ADD COLUMN IF NOT EXISTS edited_timestamp TIMESTAMPTZ;

-- Create improved sync_log table
CREATE TABLE IF NOT EXISTS sync_log (
  sync_id TEXT PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running', -- 'running', 'completed', 'failed'
  total_messages INTEGER DEFAULT 0,
  total_replies INTEGER DEFAULT 0,
  channels_processed INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for querying recent completed syncs
CREATE INDEX IF NOT EXISTS idx_sync_log_completed ON sync_log(completed_at DESC) WHERE status = 'completed';
CREATE INDEX IF NOT EXISTS idx_sync_log_status ON sync_log(status, started_at DESC);

-- Optional: Add comments for documentation
COMMENT ON TABLE sync_log IS 'Tracks sync operations with start/completion times for smart incremental syncing';
COMMENT ON COLUMN sync_log.sync_id IS 'Unique identifier for this sync run';
COMMENT ON COLUMN sync_log.started_at IS 'When the sync started (used to calculate recheck window)';
COMMENT ON COLUMN sync_log.completed_at IS 'When the sync completed successfully';
COMMENT ON COLUMN sync_log.status IS 'Current status: running, completed, or failed';
COMMENT ON COLUMN sync_log.total_messages IS 'Number of new messages synced';
COMMENT ON COLUMN sync_log.total_replies IS 'Number of thread replies synced';
COMMENT ON COLUMN sync_log.channels_processed IS 'Number of channels processed in this sync';

-- Optional: Cleanup old running syncs (stuck processes)
-- Run this periodically or before each sync
-- DELETE FROM sync_log 
-- WHERE status = 'running' 
-- AND started_at < NOW() - INTERVAL '6 hours';