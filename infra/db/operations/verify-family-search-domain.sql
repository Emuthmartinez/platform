-- U8 verification for the family-search domain (0018).
-- Happy path after apply: every null_rows value is 0.

SELECT 'data_deletion_requests' AS table_name,
       count(*) FILTER (
         WHERE organization_id IS NULL OR incident_id IS NULL
       ) AS null_rows,
       count(*) AS total_rows
  FROM data_deletion_requests
UNION ALL
SELECT 'failed_submissions',
       count(*) FILTER (
         WHERE organization_id IS NULL OR incident_id IS NULL
       ),
       count(*)
  FROM failed_submissions
UNION ALL
SELECT 'missing_person_suppressions',
       count(*) FILTER (
         WHERE organization_id IS NULL OR incident_id IS NULL
       ),
       count(*)
  FROM missing_person_suppressions
UNION ALL
SELECT 'missing_persons',
       count(*) FILTER (
         WHERE organization_id IS NULL OR incident_id IS NULL
       ),
       count(*)
  FROM missing_persons
UNION ALL
SELECT 'missing_pets',
       count(*) FILTER (
         WHERE organization_id IS NULL OR incident_id IS NULL
       ),
       count(*)
  FROM missing_pets
UNION ALL
SELECT 'ocr_corrections',
       count(*) FILTER (
         WHERE organization_id IS NULL OR incident_id IS NULL
       ),
       count(*)
  FROM ocr_corrections
UNION ALL
SELECT 'official_deceased_lists',
       count(*) FILTER (
         WHERE organization_id IS NULL OR incident_id IS NULL
       ),
       count(*)
  FROM official_deceased_lists
UNION ALL
SELECT 'official_deceased_records',
       count(*) FILTER (
         WHERE organization_id IS NULL OR incident_id IS NULL
       ),
       count(*)
  FROM official_deceased_records
UNION ALL
SELECT 'patient_import_rows',
       count(*) FILTER (
         WHERE organization_id IS NULL OR incident_id IS NULL
       ),
       count(*)
  FROM patient_import_rows
UNION ALL
SELECT 'patient_imports',
       count(*) FILTER (
         WHERE organization_id IS NULL OR incident_id IS NULL
       ),
       count(*)
  FROM patient_imports
UNION ALL
SELECT 'person_cluster_members',
       count(*) FILTER (
         WHERE organization_id IS NULL OR incident_id IS NULL
       ),
       count(*)
  FROM person_cluster_members
UNION ALL
SELECT 'person_clusters',
       count(*) FILTER (
         WHERE organization_id IS NULL OR incident_id IS NULL
       ),
       count(*)
  FROM person_clusters
UNION ALL
SELECT 'person_link_decisions',
       count(*) FILTER (
         WHERE organization_id IS NULL OR incident_id IS NULL
       ),
       count(*)
  FROM person_link_decisions
UNION ALL
SELECT 'person_links',
       count(*) FILTER (
         WHERE organization_id IS NULL OR incident_id IS NULL
       ),
       count(*)
  FROM person_links
UNION ALL
SELECT 'person_records',
       count(*) FILTER (
         WHERE organization_id IS NULL OR incident_id IS NULL
       ),
       count(*)
  FROM person_records
UNION ALL
SELECT 'record_status_signals',
       count(*) FILTER (
         WHERE organization_id IS NULL OR incident_id IS NULL
       ),
       count(*)
  FROM record_status_signals
UNION ALL
SELECT 'unidentified_persons',
       count(*) FILTER (
         WHERE organization_id IS NULL OR incident_id IS NULL
       ),
       count(*)
  FROM unidentified_persons
 ORDER BY table_name;
