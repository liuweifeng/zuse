

ALTER TABLE "api_environments" ADD COLUMN IF NOT EXISTS "sharing_audience" jsonb;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_environments_sharing_idx" ON "api_environments" USING gin ("sharing_audience");

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "api_workspace_settings" (
  "owner_id" text PRIMARY KEY NOT NULL,
  "revision" integer NOT NULL,
  "values" jsonb NOT NULL,
  CONSTRAINT "api_workspace_settings_revision_positive" CHECK ("revision" > 0),
  CONSTRAINT "api_workspace_settings_values_object" CHECK (jsonb_typeof("values") = 'object')
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS api_model_connections (
 account_id text NOT NULL,
 provider text NOT NULL CHECK (provider IN ('chatgpt','supergrok')),
 kind text NOT NULL CHECK (kind IN ('active','pending')),
 connection_id text NOT NULL,
 envelope text NOT NULL,
 PRIMARY KEY(account_id,provider,kind,connection_id)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS api_model_connection_leases (
 account_id text NOT NULL,
 provider text NOT NULL CHECK (provider IN ('chatgpt','supergrok')),
 token text NOT NULL,
 expires_at_ms bigint NOT NULL,
 PRIMARY KEY(account_id,provider)
);

--> statement-breakpoint
