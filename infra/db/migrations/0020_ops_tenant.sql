-- Donations, psychology counters, and api_keys (KTD6/KTD8). FKs NOT VALID.
ALTER TABLE "api_keys" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "incident_id" text;--> statement-breakpoint
ALTER TABLE "click_counter_dedup" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "click_counter_dedup" ADD COLUMN "incident_id" text;--> statement-breakpoint
ALTER TABLE "click_counters" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "click_counters" ADD COLUMN "incident_id" text;--> statement-breakpoint
ALTER TABLE "donations" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "donations" ADD COLUMN "incident_id" text;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_incident_ownership_fk" FOREIGN KEY ("organization_id","incident_id") REFERENCES "public"."incidents"("organization_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "click_counter_dedup" ADD CONSTRAINT "click_counter_dedup_incident_ownership_fk" FOREIGN KEY ("organization_id","incident_id") REFERENCES "public"."incidents"("organization_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "click_counters" ADD CONSTRAINT "click_counters_incident_ownership_fk" FOREIGN KEY ("organization_id","incident_id") REFERENCES "public"."incidents"("organization_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "donations" ADD CONSTRAINT "donations_incident_ownership_fk" FOREIGN KEY ("organization_id","incident_id") REFERENCES "public"."incidents"("organization_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;