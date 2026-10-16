-- Listing requests queue (request_listing tool / POST /v1/requests).
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wanted TEXT NOT NULL,
  norm TEXT NOT NULL,              -- normalized wanted text (dedupe key, with category)
  category TEXT NOT NULL,
  url TEXT,                        -- user-supplied; public only once verified
  url_key TEXT,                    -- host+path, lowercased (dedupe key)
  reasons TEXT NOT NULL DEFAULT '[]', -- JSON array of up to 10 reasons (admin only)
  requesters TEXT NOT NULL DEFAULT '[]', -- JSON array of up to 10 agent names (admin only)
  votes INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','listed','rejected')),
  entry_id TEXT,                   -- directory entry id once listed
  note TEXT,                       -- curator note
  internal INTEGER NOT NULL DEFAULT 0,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS requests_norm ON requests(category, norm);
CREATE INDEX IF NOT EXISTS requests_url ON requests(url_key);
CREATE INDEX IF NOT EXISTS requests_status ON requests(status, votes);
-- One vote per IP hash per request.
CREATE TABLE IF NOT EXISTS votes (
  request_id INTEGER NOT NULL,
  ip_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (request_id, ip_hash)
);
-- Submission log for rate limiting (ip hash + client hash); pruned after 2 days.
CREATE TABLE IF NOT EXISTS submissions (
  rl_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS submissions_key ON submissions(rl_key, created_at);
