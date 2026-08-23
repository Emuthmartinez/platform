-- Hub federation tables (KTD6 expand). Composite FKs are NOT VALID.
ALTER TABLE "hub_checkins" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "hub_checkins" ADD COLUMN "incident_id" text;--> statement-breakpoint
ALTER TABLE "hub_credentials" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "hub_credentials" ADD COLUMN "incident_id" text;--> statement-breakpoint
ALTER TABLE "hub_damaged_buildings" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "hub_damaged_buildings" ADD COLUMN "incident_id" text;--> statement-breakpoint
ALTER TABLE "hub_help_offers" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "hub_help_offers" ADD COLUMN "incident_id" text;--> statement-breakpoint
ALTER TABLE "hub_help_requests" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "hub_help_requests" ADD COLUMN "incident_id" text;--> statement-breakpoint
ALTER TABLE "hub_missing_persons" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "hub_missing_persons" ADD COLUMN "incident_id" text;--> statement-breakpoint
ALTER TABLE "hub_sync_state" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "hub_sync_state" ADD COLUMN "incident_id" text;--> statement-breakpoint
ALTER TABLE "hub_checkins" ADD CONSTRAINT "hub_checkins_incident_ownership_fk" FOREIGN KEY ("organization_id","incident_id") REFERENCES "public"."incidents"("organization_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "hub_credentials" ADD CONSTRAINT "hub_credentials_incident_ownership_fk" FOREIGN KEY ("organization_id","incident_id") REFERENCES "public"."incidents"("organization_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "hub_damaged_buildings" ADD CONSTRAINT "hub_damaged_buildings_incident_ownership_fk" FOREIGN KEY ("organization_id","incident_id") REFERENCES "public"."incidents"("organization_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "hub_help_offers" ADD CONSTRAINT "hub_help_offers_incident_ownership_fk" FOREIGN KEY ("organization_id","incident_id") REFERENCES "public"."incidents"("organization_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "hub_help_requests" ADD CONSTRAINT "hub_help_requests_incident_ownership_fk" FOREIGN KEY ("organization_id","incident_id") REFERENCES "public"."incidents"("organization_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "hub_missing_persons" ADD CONSTRAINT "hub_missing_persons_incident_ownership_fk" FOREIGN KEY ("organization_id","incident_id") REFERENCES "public"."incidents"("organization_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "hub_sync_state" ADD CONSTRAINT "hub_sync_state_incident_ownership_fk" FOREIGN KEY ("organization_id","incident_id") REFERENCES "public"."incidents"("organization_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;