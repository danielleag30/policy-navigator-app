-- Add gen_random_uuid() default to pending_alerts.id so the orchestrator
-- can insert rows without explicitly generating an ID.
ALTER TABLE pending_alerts ALTER COLUMN id SET DEFAULT gen_random_uuid();
