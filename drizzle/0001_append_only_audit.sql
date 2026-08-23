-- Make `audit_events` append-only at the database, not merely by convention.
--
-- ADR-0003: the rule-auditor's entire claim ("zero violations, judged from the
-- audit log alone") rests on the log being complete and untampered. Application
-- discipline alone is a promise; this is an enforcement.
--
-- INSERT stays allowed. UPDATE and DELETE raise, so a stray migration, a manual
-- psql session, or a future bug cannot quietly rewrite history.

CREATE OR REPLACE FUNCTION audit_events_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'audit_events is append-only (ADR-0003): % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER audit_events_no_update
    BEFORE UPDATE ON "audit_events"
    FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();
--> statement-breakpoint
CREATE TRIGGER audit_events_no_delete
    BEFORE DELETE ON "audit_events"
    FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();
