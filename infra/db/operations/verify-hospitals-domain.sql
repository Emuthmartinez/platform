-- U8 verification for the hospitals domain (0017).
-- Happy path after apply: every null_rows value is 0.

SELECT 'hospital_patients' AS table_name,
       count(*) FILTER (
         WHERE organization_id IS NULL OR incident_id IS NULL
       ) AS null_rows,
       count(*) AS total_rows
  FROM hospital_patients
UNION ALL
SELECT 'hospital_poc_assignments',
       count(*) FILTER (
         WHERE organization_id IS NULL OR incident_id IS NULL
       ),
       count(*)
  FROM hospital_poc_assignments
UNION ALL
SELECT 'hospital_supply_events',
       count(*) FILTER (
         WHERE organization_id IS NULL OR incident_id IS NULL
       ),
       count(*)
  FROM hospital_supply_events
UNION ALL
SELECT 'hospital_supply_help_requests',
       count(*) FILTER (
         WHERE organization_id IS NULL OR incident_id IS NULL
       ),
       count(*)
  FROM hospital_supply_help_requests
UNION ALL
SELECT 'hospital_supply_needs',
       count(*) FILTER (
         WHERE organization_id IS NULL OR incident_id IS NULL
       ),
       count(*)
  FROM hospital_supply_needs
UNION ALL
SELECT 'hospital_supply_statuses',
       count(*) FILTER (
         WHERE organization_id IS NULL OR incident_id IS NULL
       ),
       count(*)
  FROM hospital_supply_statuses
UNION ALL
SELECT 'hospitals',
       count(*) FILTER (
         WHERE organization_id IS NULL OR incident_id IS NULL
       ),
       count(*)
  FROM hospitals
 ORDER BY table_name;
