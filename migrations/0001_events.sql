-- Play statistics from the Time Travel Heist app. See src/worker.js for what is accepted and
-- game/metrics.js in the game repo for what is sent and when.
--
-- ONE ROW PER EVENT, and six kinds of event: attempt/complete × level/section/campaign. A player is
-- a random UUID made on their phone (player_id), a playthrough is another (save_id). Neither is
-- linked to anything else, and no IP address, user agent or other request detail is stored.
--
-- event_id is the client's UUID for the event, UNIQUE so a batch re-sent after a dropped response
-- inserts nothing the second time.

CREATE TABLE events (
  id            INTEGER PRIMARY KEY,
  event_id      TEXT    NOT NULL UNIQUE,
  player_id     TEXT    NOT NULL,
  save_id       TEXT    NOT NULL,
  kind          TEXT    NOT NULL CHECK (kind IN ('attempt', 'complete')),
  scope         TEXT    NOT NULL CHECK (scope IN ('level', 'section', 'campaign')),
  campaign      INTEGER NOT NULL,          -- campaign release, e.g. 6 for r6
  section       TEXT,                      -- null for campaign events
  level_id      TEXT,                      -- level events only
  level_version INTEGER,                   -- level events only
  play_ms       INTEGER,                   -- completions: play time spent reaching it
  hints         INTEGER,                   -- completions: hints shown reaching it
  partial       INTEGER NOT NULL DEFAULT 0, -- 1: started before the app tracked it, so ms/hints are short
  app_version   TEXT,
  lang          TEXT,
  client_at     INTEGER,                   -- ms since epoch, the phone's clock
  received_at   INTEGER NOT NULL           -- ms since epoch, the server's clock
);

CREATE INDEX events_level   ON events (scope, campaign, level_id, level_version, kind);
CREATE INDEX events_section ON events (scope, campaign, section, kind);
CREATE INDEX events_player  ON events (player_id);

-- ---------- summaries ----------
-- Players, not events: DISTINCT player_id is the deduplication the UUID exists for — one person
-- replaying a level in three save slots is one player. Time and hints are averaged over complete,
-- non-partial rows only, so a save that predates tracking does not drag the figures down.

CREATE VIEW level_stats AS
SELECT
  campaign,
  level_id,
  level_version,
  COUNT(DISTINCT CASE WHEN kind = 'attempt'  THEN player_id END)                        AS players_attempted,
  COUNT(DISTINCT CASE WHEN kind = 'complete' THEN player_id END)                        AS players_completed,
  ROUND(AVG(CASE WHEN kind = 'complete' AND partial = 0 THEN play_ms END) / 1000.0, 1) AS avg_secs_to_complete,
  ROUND(AVG(CASE WHEN kind = 'complete' AND partial = 0 THEN hints END), 2)            AS avg_hints_to_complete
FROM events
WHERE scope = 'level'
GROUP BY campaign, level_id, level_version;

CREATE VIEW section_stats AS
SELECT
  campaign,
  section,
  COUNT(DISTINCT CASE WHEN kind = 'attempt'  THEN player_id END)                        AS players_attempted,
  COUNT(DISTINCT CASE WHEN kind = 'complete' THEN player_id END)                        AS players_completed,
  ROUND(AVG(CASE WHEN kind = 'complete' AND partial = 0 THEN play_ms END) / 1000.0, 1) AS avg_secs_to_complete,
  ROUND(AVG(CASE WHEN kind = 'complete' AND partial = 0 THEN hints END), 2)            AS avg_hints_to_complete
FROM events
WHERE scope = 'section'
GROUP BY campaign, section;

CREATE VIEW campaign_stats AS
SELECT
  campaign,
  COUNT(DISTINCT CASE WHEN kind = 'attempt'  THEN player_id END)                        AS players_attempted,
  COUNT(DISTINCT CASE WHEN kind = 'complete' THEN player_id END)                        AS players_completed,
  ROUND(AVG(CASE WHEN kind = 'complete' AND partial = 0 THEN play_ms END) / 1000.0, 1) AS avg_secs_to_complete,
  ROUND(AVG(CASE WHEN kind = 'complete' AND partial = 0 THEN hints END), 2)            AS avg_hints_to_complete
FROM events
WHERE scope = 'campaign'
GROUP BY campaign;
