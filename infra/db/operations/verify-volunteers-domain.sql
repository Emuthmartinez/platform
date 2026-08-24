-- U8 verification for the volunteers domain (0016).
-- Happy path after apply: every null_rows value is 0.

SELECT 'volunteer_assignments' AS table_name,
       count(*) FILTER (
         WHERE organization_id IS NULL OR incident_id IS NULL
       ) AS null_rows,
       count(*) AS total_rows
  FROM volunteer_assignments
UNION ALL
SELECT 'volunteer_checkins',
       count(*) FILTER (
         WHERE organization_id IS NULL OR incident_id IS NULL
       ),
       count(*)
  FROM volunteer_checkins
UNION ALL
SELECT 'volunteer_tasks',
       count(*) FILTER (
         WHERE organization_id IS NULL OR incident_id IS NULL
       ),
       count(*)
  FROM volunteer_tasks
UNION ALL
SELECT 'volunteers',
       count(*) FILTER (
         WHERE organization_id IS NULL OR incident_id IS NULL
       ),
       count(*)
  FROM volunteers
 ORDER BY table_name;
