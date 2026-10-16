

ALTER TABLE "api_environments" ADD COLUMN IF NOT EXISTS "sharing_audience" jsonb;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_environments_sharing_idx" ON "api_environments" USING gin ("sharing_audience");
