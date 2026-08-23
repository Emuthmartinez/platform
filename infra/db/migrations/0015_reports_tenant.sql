-- Citizen reports surface (KTD6 expand). Columns are nullable.
-- Composite FKs are NOT VALID so a later apply on a populated Colombia
-- database does not scan live tables inside the 60s migrator timeout.
ALTER TABLE "analytics_events" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "analytics_events" ADD COLUMN "incident_id" text;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "incident_id" text;--> statement-breakpoint
ALTER TABLE "contact_messages" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "contact_messages" ADD COLUMN "incident_id" text;--> statement-breakpoint
ALTER TABLE "damage_candidates" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "damage_candidates" ADD COLUMN "incident_id" text;--> statement-breakpoint
ALTER TABLE "report_confirmations" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "report_confirmations" ADD COLUMN "incident_id" text;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "incident_id" text;--> statement-breakpoint
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_incident_ownership_fk" FOREIGN KEY ("organization_id","incident_id") REFERENCES "public"."incidents"("organization_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_incident_ownership_fk" FOREIGN KEY ("organization_id","incident_id") REFERENCES "public"."incidents"("organization_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "contact_messages" ADD CONSTRAINT "contact_messages_incident_ownership_fk" FOREIGN KEY ("organization_id","incident_id") REFERENCES "public"."incidents"("organization_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "damage_candidates" ADD CONSTRAINT "damage_candidates_incident_ownership_fk" FOREIGN KEY ("organization_id","incident_id") REFERENCES "public"."incidents"("organization_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "report_confirmations" ADD CONSTRAINT "report_confirmations_incident_ownership_fk" FOREIGN KEY ("organization_id","incident_id") REFERENCES "public"."incidents"("organization_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_incident_ownership_fk" FOREIGN KEY ("organization_id","incident_id") REFERENCES "public"."incidents"("organization_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;
