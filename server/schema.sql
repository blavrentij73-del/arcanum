CREATE TABLE IF NOT EXISTS players (
  user_id        TEXT PRIMARY KEY,
  name           TEXT NOT NULL DEFAULT 'Игрок',
  trophies       INTEGER NOT NULL DEFAULT 0,
  best           INTEGER NOT NULL DEFAULT 0,
  season         TEXT NOT NULL DEFAULT '',
  updated_at     INTEGER NOT NULL DEFAULT 0,
  last_battle_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_players_trophies
  ON players (trophies DESC, updated_at ASC);

CREATE TABLE IF NOT EXISTS purchases (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,
  stars      INTEGER NOT NULL,
  claimed    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_purchases_user
  ON purchases (user_id, claimed);
