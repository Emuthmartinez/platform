-- Hospital and shelter surface (KTD6 expand). Composite FKs are NOT VALID.
ALTER TABLE "hospital_patients" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "hospital_patients" ADD COLUMN "incident_id" text;--> statement-breakpoint
ALTER TABLE "hospital_poc_assignments" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "hospital_poc_assignments" ADD COLUMN "incident_id" text;--> statement-breakpoint
ALTER TABLE "hospital_supply_events" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "hospital_supply_events" ADD COLUMN "incident_id" text;--> statement-breakpoint
ALTER TABLE "hospital_supply_help_requests" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "hospital_supply_help_requests" ADD COLUMN "incident_id" text;--> statement-breakpoint
ALTER TABLE "hospital_supply_needs" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "hospital_supply_needs" ADD COLUMN "incident_id" text;--> statement-breakpoint
ALTER TABLE "hospital_supply_statuses" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "hospital_supply_statuses" ADD COLUMN "incident_id" text;--> statement-breakpoint
ALTER TABLE "hospitals" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "hospitals" ADD COLUMN "incident_id" text;--> statement-breakpoint
ALTER TABLE "hospital_patients" ADD CONSTRAINT "hospital_patients_incident_ownership_fk" FOREIGN KEY ("organization_id","incident_id") REFERENCES "public"."incidents"("organization_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "hospital_poc_assignments" ADD CONSTRAINT "hospital_poc_assignments_incident_ownership_fk" FOREIGN KEY ("organization_id","incident_id") REFERENCES "public"."incidents"("organization_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "hospital_supply_events" ADD CONSTRAINT "hospital_supply_events_incident_ownership_fk" FOREIGN KEY ("organization_id","incident_id") REFERENCES "public"."incidents"("organization_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "hospital_supply_help_requests" ADD CONSTRAINT "hospital_supply_help_requests_incident_ownership_fk" FOREIGN KEY ("organization_id","incident_id") REFERENCES "public"."incidents"("organization_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "hospital_supply_needs" ADD CONSTRAINT "hospital_supply_needs_incident_ownership_fk" FOREIGN KEY ("organization_id","incident_id") REFERENCES "public"."incidents"("organization_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "hospital_supply_statuses" ADD CONSTRAINT "hospital_supply_statuses_incident_ownership_fk" FOREIGN KEY ("organization_id","incident_id") REFERENCES "public"."incidents"("organization_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "hospitals" ADD CONSTRAINT "hospitals_incident_ownership_fk" FOREIGN KEY ("organization_id","incident_id") REFERENCES "public"."incidents"("organization_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;