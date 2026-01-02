CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  channel_name TEXT,
  user_id TEXT,
  username TEXT,
  text TEXT,
  timestamp TIMESTAMP NOT NULL,
  thread_ts TEXT,
  raw_json JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_messages_channel ON messages(channel_id);
CREATE INDEX idx_messages_timestamp ON messages(timestamp);
CREATE INDEX idx_messages_user ON messages(user_id);