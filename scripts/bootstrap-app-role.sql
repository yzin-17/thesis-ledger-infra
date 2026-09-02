\set ON_ERROR_STOP on

-- 官方 PostgreSQL entrypoint 会以 POSTGRES_USER 执行本文件。
\getenv owner_user POSTGRES_OWNER_USER
\getenv app_user POSTGRES_APP_USER
\getenv app_password POSTGRES_APP_PASSWORD

SELECT length(:'owner_user') = 0 OR length(:'app_user') = 0 AS roles_missing,
       :'owner_user' = :'app_user' AS roles_same,
       current_user <> :'owner_user' AS owner_mismatch
\gset
\if :roles_missing
\echo POSTGRES_OWNER_USER and POSTGRES_APP_USER must be non-empty
SELECT 1 / 0 AS invalid_role_configuration;
\endif
\if :roles_same
\echo POSTGRES_APP_USER must differ from POSTGRES_OWNER_USER
SELECT 1 / 0 AS invalid_role_configuration;
\endif
\if :owner_mismatch
\echo PostgreSQL init user must match POSTGRES_OWNER_USER
SELECT 1 / 0 AS invalid_role_configuration;
\endif

SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'app_user', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_user')
\gexec

SELECT format(
  'ALTER ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
  :'app_user',
  :'app_password'
)
\gexec

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;

SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'app_user')
\gexec
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'app_user')
\gexec
SELECT format(
  'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I',
  :'app_user'
)
\gexec
SELECT format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', :'app_user')
\gexec

SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I',
  :'owner_user',
  :'app_user'
)
\gexec
SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I',
  :'owner_user',
  :'app_user'
)
\gexec

SELECT format('REVOKE INSERT, UPDATE, DELETE ON TABLE %I FROM %I', 'SchemaVersion', :'app_user')
\gexec
SELECT format('REVOKE UPDATE, DELETE ON TABLE %I FROM %I', 'LedgerEvent', :'app_user')
\gexec
