

INSERT INTO "api_provider_price_schedule" ("provider","version","effective_at","base_nano_usd_per_second","cpu_nano_usd_per_second","memory_nano_usd_per_gib_second","storage_nano_usd_per_gib_second","created_at") VALUES ('box','box-public-2026-08-17',0,0,2150,175,0,0) ON CONFLICT DO NOTHING;

ALTER TABLE "api_provider_usage_events" ADD COLUMN IF NOT EXISTS "occurred_at" bigint;
CREATE TABLE IF NOT EXISTS "api_provider_lifecycle_pairs" (
  "provider" text NOT NULL,
  "closing_event_id" text NOT NULL,
  "opening_event_id" text NOT NULL,
  "started_at" bigint NOT NULL,
  PRIMARY KEY ("provider", "closing_event_id"),
  FOREIGN KEY ("provider", "closing_event_id") REFERENCES "api_provider_usage_events" ("provider", "event_id") ON DELETE CASCADE,
  FOREIGN KEY ("provider", "opening_event_id") REFERENCES "api_provider_usage_events" ("provider", "event_id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "api_provider_lifecycle_pairs_opening_idx" ON "api_provider_lifecycle_pairs" ("provider", "opening_event_id");
