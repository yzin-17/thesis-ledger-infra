\set ON_ERROR_STOP on

SELECT length(:'owner_user') = 0 OR length(:'app_user') = 0 AS roles_missing,
       :'owner_user' = :'app_user' AS roles_same
\gset
\if :roles_missing
\echo owner_user and app_user must be non-empty
SELECT 1 / 0 AS invalid_role_configuration;
\endif
\if :roles_same
\echo owner_user and app_user must be different roles
SELECT 1 / 0 AS invalid_role_configuration;
\endif

SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'app_user', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_user')
\gexec

SELECT format('ALTER ROLE %I LOGIN PASSWORD %L', :'app_user', :'app_password')
\gexec

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

SELECT format('REVOKE UPDATE, DELETE ON TABLE %I FROM %I', 'LedgerEvent', :'app_user')
WHERE to_regclass('"LedgerEvent"') IS NOT NULL
\gexec
