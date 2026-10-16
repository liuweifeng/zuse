

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM api_cloud_workspace_pool WHERE state <> 'claimed') THEN
    RAISE EXCEPTION 'Retire unclaimed workspace pool sandboxes before dropping the pool table';
  END IF;
END $$;
--> statement-breakpoint
DROP TABLE api_cloud_workspace_pool;
