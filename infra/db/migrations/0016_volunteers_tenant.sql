-- Volunteer surface (KTD6 expand). Composite FKs are NOT VALID.
ALTER TABLE "volunteer_assignments" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "volunteer_assignments" ADD COLUMN "incident_id" text;--> statement-breakpoint
ALTER TABLE "volunteer_checkins" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "volunteer_checkins" ADD COLUMN "incident_id" text;--> statement-breakpoint
ALTER TABLE "volunteer_tasks" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "volunteer_tasks" ADD COLUMN "incident_id" text;--> statement-breakpoint
ALTER TABLE "volunteers" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "volunteers" ADD COLUMN "incident_id" text;--> statement-breakpoint
ALTER TABLE "volunteer_assignments" ADD CONSTRAINT "volunteer_assignments_incident_ownership_fk" FOREIGN KEY ("organization_id","incident_id") REFERENCES "public"."incidents"("organization_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "volunteer_checkins" ADD CONSTRAINT "volunteer_checkins_incident_ownership_fk" FOREIGN KEY ("organization_id","incident_id") REFERENCES "public"."incidents"("organization_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "volunteer_tasks" ADD CONSTRAINT "volunteer_tasks_incident_ownership_fk" FOREIGN KEY ("organization_id","incident_id") REFERENCES "public"."incidents"("organization_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "volunteers" ADD CONSTRAINT "volunteers_incident_ownership_fk" FOREIGN KEY ("organization_id","incident_id") REFERENCES "public"."incidents"("organization_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;