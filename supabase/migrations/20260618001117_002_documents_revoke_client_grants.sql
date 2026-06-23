-- Supabase grants broad public-schema table privileges to client roles by default.
-- Keep documents inaccessible until explicit RLS policies and grants are introduced.

REVOKE ALL ON TABLE documents FROM anon, authenticated;
