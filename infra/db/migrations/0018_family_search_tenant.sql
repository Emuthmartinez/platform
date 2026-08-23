-- Family-search slice (KTD6 expand). Composite FKs are NOT VALID.
ALTER TABLE "data_deletion_requests" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "data_deletion_requests" ADD COLUMN "incident_id" text;--> statement-breakpoint
ALTER TABLE "failed_submissions" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "failed_submissions" ADD COLUMN "incident_id" text;--> statement-breakpoint
ALTER TABLE "missing_person_suppressions" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "missing_person_suppressions" ADD COLUMN "incident_id" text;--> statement-breakpoint
ALTER TABLE "missing_persons" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "missing_persons" ADD COLUMN "incident_id" text;--> statement-breakpoint
ALTER TABLE "missing_pets" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "missing_pets" ADD COLUMN "incident_id" text;--> statement-breakpoint
ALTER TABLE "ocr_corrections" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "ocr_corrections" ADD COLUMN "incident_id" text;--> statement-breakpoint
ALTER TABLE "official_deceased_lists" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "official_deceased_lists" ADD COLUMN "incident_id" text;--> statement-breakpoint
ALTER TABLE "official_deceased_records" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "official_deceased_records" ADD COLUMN "incident_id" text;--> statement-breakpoint
ALTER TABLE "patient_import_rows" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "patient_import_rows" ADD COLUMN "incident_id" text;--> statement-breakpoint
ALTER TABLE "patient_imports" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "patient_imports" ADD COLUMN "incident_id" text;--> statement-breakpoint
ALTER TABLE "person_cluster_members" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "person_cluster_members" ADD COLUMN "incident_id" text;--> statement-breakpoint
ALTER TABLE "person_clusters" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "person_clusters" ADD COLUMN "incident_id" text;--> statement-breakpoint
ALTER TABLE "person_link_decisions" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "person_link_decisions" ADD COLUMN "incident_id" text;--> statement-breakpoint
ALTER TABLE "person_links" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "person_links" ADD COLUMN "incident_id" text;--> statement-breakpoint
ALTER TABLE "person_records" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "person_records" ADD COLUMN "incident_id" text;--> statement-breakpoint
ALTER TABLE "record_status_signals" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "record_status_signals" ADD COLUMN "incident_id" text;--> statement-breakpoint
ALTER TABLE "unidentified_persons" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "unidentified_persons" ADD COLUMN "incident_id" text;--> statement-breakpoint
ALTER TABLE "data_deletion_requests" ADD CONSTRAINT "data_deletion_requests_incident_ownership_fk" FOREIGN KEY ("organization_id","incident_id") REFERENCES "public"."incidents"("organization_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "failed_submissions" ADD CONSTRAINT "failed_submissions_incident_ownership_fk" FOREIGN KEY ("organization_id","incident_id") REFERENCES "public"."incidents"("organization_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "missing_person_suppressions" ADD CONSTRAINT "missing_person_suppressions_incident_ownership_fk" FOREIGN KEY ("organization_id","incident_id") REFERENCES "public"."incidents"("organization_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "missing_persons" ADD CONSTRAINT "missing_persons_incident_ownership_fk" FOREIGN KEY ("organization_id","incident_id") REFERENCES "public"."incidents"("organization_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "missing_pets" ADD CONSTRAINT "missing_pets_incident_ownership_fk" FOREIGN KEY ("organization_id","incident_id") REFERENCES "public"."incidents"("organization_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "ocr_corrections" ADD CONSTRAINT "ocr_corrections_incident_ownership_fk" FOREIGN KEY ("organization_id","incident_id") REFERENCES "public"."incidents"("organization_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "official_deceased_lists" ADD CONSTRAINT "official_deceased_lists_incident_ownership_fk" FOREIGN KEY ("organization_id","incident_id") REFERENCES "public"."incidents"("organization_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "official_deceased_records" ADD CONSTRAINT "official_deceased_records_incident_ownership_fk" FOREIGN KEY ("organization_id","incident_id") REFERENCES "public"."incidents"("organization_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "patient_import_rows" ADD CONSTRAINT "patient_import_rows_incident_ownership_fk" FOREIGN KEY ("organization_id","incident_id") REFERENCES "public"."incidents"("organization_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "patient_imports" ADD CONSTRAINT "patient_imports_incident_ownership_fk" FOREIGN KEY ("organization_id","incident_id") REFERENCES "public"."incidents"("organization_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "person_cluster_members" ADD CONSTRAINT "person_cluster_members_incident_ownership_fk" FOREIGN KEY ("organization_id","incident_id") REFERENCES "public"."incidents"("organization_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "person_clusters" ADD CONSTRAINT "person_clusters_incident_ownership_fk" FOREIGN KEY ("organization_id","incident_id") REFERENCES "public"."incidents"("organization_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "person_link_decisions" ADD CONSTRAINT "person_link_decisions_incident_ownership_fk" FOREIGN KEY ("organization_id","incident_id") REFERENCES "public"."incidents"("organization_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "person_links" ADD CONSTRAINT "person_links_incident_ownership_fk" FOREIGN KEY ("organization_id","incident_id") REFERENCES "public"."incidents"("organization_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "person_records" ADD CONSTRAINT "person_records_incident_ownership_fk" FOREIGN KEY ("organization_id","incident_id") REFERENCES "public"."incidents"("organization_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "record_status_signals" ADD CONSTRAINT "record_status_signals_incident_ownership_fk" FOREIGN KEY ("organization_id","incident_id") REFERENCES "public"."incidents"("organization_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "unidentified_persons" ADD CONSTRAINT "unidentified_persons_incident_ownership_fk" FOREIGN KEY ("organization_id","incident_id") REFERENCES "public"."incidents"("organization_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;