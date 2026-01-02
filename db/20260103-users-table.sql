CREATE TABLE users (
  id TEXT PRIMARY KEY,
  team_id TEXT,
  name TEXT,
  real_name TEXT,
  display_name TEXT,
  email TEXT,
  deleted BOOLEAN,
  is_bot BOOLEAN,
  is_admin BOOLEAN,
  is_owner BOOLEAN,
  updated BIGINT,
  raw_json JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_name ON users(name);
