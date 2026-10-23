

ALTER TABLE api_cloud_workspace_usage DROP CONSTRAINT IF EXISTS api_cloud_usage_kind_check;
ALTER TABLE api_cloud_workspace_usage DROP CONSTRAINT IF EXISTS relay_cloud_usage_kind_check;
ALTER TABLE api_cloud_workspace_usage ADD CONSTRAINT api_cloud_usage_kind_check
CHECK (kind IN ('runtime-seconds', 'lifecycle-elapsed-seconds', 'pause', 'resume', 'snapshot-bytes', 'storage-byte-seconds', 'archive', 'restore', 'delete'));
UPDATE api_cloud_workspace_usage
SET kind = 'lifecycle-elapsed-seconds'
WHERE kind = 'runtime-seconds';
