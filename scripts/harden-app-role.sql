\set ON_ERROR_STOP on

SELECT format('REVOKE UPDATE, DELETE ON TABLE %I FROM %I', 'LedgerEvent', :'app_user')
WHERE to_regclass('"LedgerEvent"') IS NOT NULL
\gexec
