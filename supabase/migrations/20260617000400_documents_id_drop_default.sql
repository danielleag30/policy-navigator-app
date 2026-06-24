-- Remediation for 001_documents.sql: drop the server-side gen_random_uuid() default
-- that was incorrectly applied on initial migration. UUIDs must be Deno-generated (v7).
ALTER TABLE documents ALTER COLUMN id DROP DEFAULT;
