-- Reconstruction campaign tables are handwritten (not in drizzle-kit generate).
-- KTD6 expand: nullable ownership plus NOT VALID composite FKs.
ALTER TABLE "campaign_sites" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "campaign_sites" ADD COLUMN "incident_id" text;--> statement-breakpoint
ALTER TABLE "campaign_site_stewards" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "campaign_site_stewards" ADD COLUMN "incident_id" text;--> statement-breakpoint
ALTER TABLE "material_pledges" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "material_pledges" ADD COLUMN "incident_id" text;--> statement-breakpoint
ALTER TABLE "material_receipts" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "material_receipts" ADD COLUMN "incident_id" text;--> statement-breakpoint
ALTER TABLE "material_shipments" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "material_shipments" ADD COLUMN "incident_id" text;--> statement-breakpoint
ALTER TABLE "campaign_sites" ADD CONSTRAINT "campaign_sites_incident_ownership_fk" FOREIGN KEY ("organization_id","incident_id") REFERENCES "public"."incidents"("organization_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "campaign_site_stewards" ADD CONSTRAINT "campaign_site_stewards_incident_ownership_fk" FOREIGN KEY ("organization_id","incident_id") REFERENCES "public"."incidents"("organization_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "material_pledges" ADD CONSTRAINT "material_pledges_incident_ownership_fk" FOREIGN KEY ("organization_id","incident_id") REFERENCES "public"."incidents"("organization_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "material_receipts" ADD CONSTRAINT "material_receipts_incident_ownership_fk" FOREIGN KEY ("organization_id","incident_id") REFERENCES "public"."incidents"("organization_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "material_shipments" ADD CONSTRAINT "material_shipments_incident_ownership_fk" FOREIGN KEY ("organization_id","incident_id") REFERENCES "public"."incidents"("organization_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;
