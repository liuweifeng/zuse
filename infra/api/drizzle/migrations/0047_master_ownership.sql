CREATE TABLE IF NOT EXISTS api_master_ownership (
  account_id text NOT NULL,
  master_id text NOT NULL,
  home_environment_id text NOT NULL,
  generation integer NOT NULL,
  repositories_json text NOT NULL,
  PRIMARY KEY (account_id, master_id)
);
