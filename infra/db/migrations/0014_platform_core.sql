CREATE TABLE "organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "incidents_organization_id_id_unique" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "deployments" (
	"hostname" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"incident_id" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "deployments_hostname_canonical" CHECK ("deployments"."hostname" = lower("deployments"."hostname") AND right("deployments"."hostname", 1) <> '.')
);
--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_incident_ownership_fk" FOREIGN KEY ("organization_id","incident_id") REFERENCES "public"."incidents"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- Colombia first tenant. IDs match backend/src/lib/colombia-tenant.ts.
-- Hostnames match config/deployment.config.json domains.
INSERT INTO "organizations" ("id", "name", "created_at")
VALUES ('org_mallanet', 'Mallanet.org', 1786320000000)
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "incidents" ("id", "organization_id", "name", "created_at")
VALUES ('inc_terremoto_colombia_2026', 'org_mallanet', 'Terremoto Colombia 2026', 1786320000000)
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "deployments" ("hostname", "organization_id", "incident_id", "created_at")
VALUES
	('terremotocolombia.co', 'org_mallanet', 'inc_terremoto_colombia_2026', 1786320000000),
	('api.terremotocolombia.co', 'org_mallanet', 'inc_terremoto_colombia_2026', 1786320000000),
	('admin.terremotocolombia.co', 'org_mallanet', 'inc_terremoto_colombia_2026', 1786320000000)
ON CONFLICT ("hostname") DO NOTHING;
