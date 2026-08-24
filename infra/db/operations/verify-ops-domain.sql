-- U8 verification for the ops domain (0020).
-- Happy path after apply: every null_rows value is 0.

SELECT 'api_keys' AS table_name,
       count(*) FILTER (
         WHERE organization_id IS NULL OR incident_id IS NULL
       ) AS null_rows,
       count(*) AS total_rows
  FROM api_keys
UNION ALL
SELECT 'click_counter_dedup',
       count(*) FILTER (
         WHERE organization_id IS NULL OR incident_id IS NULL
       ),
       count(*)
  FROM click_counter_dedup
UNION ALL
SELECT 'click_counters',
       count(*) FILTER (
         WHERE organization_id IS NULL OR incident_id IS NULL
       ),
       count(*)
  FROM click_counters
UNION ALL
SELECT 'donations',
       count(*) FILTER (
         WHERE organization_id IS NULL OR incident_id IS NULL
       ),
       count(*)
  FROM donations
 ORDER BY table_name;
