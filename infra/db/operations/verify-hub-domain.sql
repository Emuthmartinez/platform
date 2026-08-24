-- U8 verification for the hub domain (0019).
-- Happy path after apply: every null_rows value is 0.

SELECT 'hub_checkins' AS table_name,
       count(*) FILTER (
         WHERE organization_id IS NULL OR incident_id IS NULL
       ) AS null_rows,
       count(*) AS total_rows
  FROM hub_checkins
UNION ALL
SELECT 'hub_credentials',
       count(*) FILTER (
         WHERE organization_id IS NULL OR incident_id IS NULL
       ),
       count(*)
  FROM hub_credentials
UNION ALL
SELECT 'hub_damaged_buildings',
       count(*) FILTER (
         WHERE organization_id IS NULL OR incident_id IS NULL
       ),
       count(*)
  FROM hub_damaged_buildings
UNION ALL
SELECT 'hub_help_offers',
       count(*) FILTER (
         WHERE organization_id IS NULL OR incident_id IS NULL
       ),
       count(*)
  FROM hub_help_offers
UNION ALL
SELECT 'hub_help_requests',
       count(*) FILTER (
         WHERE organization_id IS NULL OR incident_id IS NULL
       ),
       count(*)
  FROM hub_help_requests
UNION ALL
SELECT 'hub_missing_persons',
       count(*) FILTER (
         WHERE organization_id IS NULL OR incident_id IS NULL
       ),
       count(*)
  FROM hub_missing_persons
UNION ALL
SELECT 'hub_sync_state',
       count(*) FILTER (
         WHERE organization_id IS NULL OR incident_id IS NULL
       ),
       count(*)
  FROM hub_sync_state
 ORDER BY table_name;
