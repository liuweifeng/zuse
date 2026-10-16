
CREATE TABLE IF NOT EXISTS "api_workspace_settings" (
  "owner_id" text PRIMARY KEY NOT NULL,
  "revision" integer NOT NULL,
  "values" jsonb NOT NULL,
  CONSTRAINT "api_workspace_settings_revision_positive" CHECK ("revision" > 0),
  CONSTRAINT "api_workspace_settings_values_object" CHECK (jsonb_typeof("values") = 'object')
);
