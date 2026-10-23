

ALTER TABLE api_cloud_billing_outbox ALTER COLUMN occurred_at
  SET DEFAULT floor(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint;
