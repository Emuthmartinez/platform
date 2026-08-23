-- Staging and local hostnames for the Colombia tenant (U9).
-- Production Workers do not use these rows. Lookup is exact-match.
INSERT INTO "deployments" ("hostname", "organization_id", "incident_id", "created_at")
VALUES
	('staging.terremotocolombia.co', 'org_mallanet', 'inc_terremoto_colombia_2026', 1786320000000),
	('api-staging.terremotocolombia.co', 'org_mallanet', 'inc_terremoto_colombia_2026', 1786320000000),
	('admin-staging.terremotocolombia.co', 'org_mallanet', 'inc_terremoto_colombia_2026', 1786320000000),
	('localhost', 'org_mallanet', 'inc_terremoto_colombia_2026', 1786320000000)
ON CONFLICT ("hostname") DO NOTHING;
