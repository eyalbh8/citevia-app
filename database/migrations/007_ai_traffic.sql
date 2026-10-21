-- Keep iGEO analytics storage and account IDs; attribution is independent of scan providers.
ALTER TABLE analytics_events ADD COLUMN traffic_provider text;
ALTER TABLE analytics_events ADD COLUMN connection_test_id text;
CREATE INDEX analytics_events_connection_test_idx ON analytics_events(account_id, connection_test_id) WHERE connection_test_id IS NOT NULL;
