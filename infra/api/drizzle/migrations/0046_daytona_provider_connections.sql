ALTER TABLE api_cloud_provider_connections DROP CONSTRAINT cloud_provider_connection_provider;
--> statement-breakpoint
ALTER TABLE api_cloud_provider_connections ADD CONSTRAINT cloud_provider_connection_provider CHECK (provider IN ('e2b', 'boxd', 'box', 'daytona'));
