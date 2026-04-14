-- Enable pg_stat_statements — must run as superuser before any connections.
-- Tracks execution stats for every query: calls, mean time, total time, rows.
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
