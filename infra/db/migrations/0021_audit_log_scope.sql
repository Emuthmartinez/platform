-- Mixed-scope audit_log (KTD10). Existing rows stay all-NULL during expand.
-- FK and CHECK are NOT VALID so a later Colombia apply does not scan the log.
ALTER TABLE "audit_log" ADD COLUMN "scope_type" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "incident_id" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_incident_ownership_fk" FOREIGN KEY ("organization_id","incident_id") REFERENCES "public"."incidents"("organization_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_scope_ids" CHECK ((
        ("audit_log"."scope_type" IS NULL AND "audit_log"."organization_id" IS NULL AND "audit_log"."incident_id" IS NULL)
        OR ("audit_log"."scope_type" = 'global' AND "audit_log"."organization_id" IS NULL AND "audit_log"."incident_id" IS NULL)
        OR ("audit_log"."scope_type" = 'organization' AND "audit_log"."organization_id" IS NOT NULL AND "audit_log"."incident_id" IS NULL)
        OR ("audit_log"."scope_type" = 'incident' AND "audit_log"."organization_id" IS NOT NULL AND "audit_log"."incident_id" IS NOT NULL)
      )) NOT VALID;
