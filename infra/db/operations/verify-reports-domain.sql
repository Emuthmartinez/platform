-- U8 verification for the citizen-reports domain (0015).
-- Run against Neon direct after count-only, then after apply.
-- Happy path after apply: every null_rows value is 0.

SELECT 'analytics_events' AS table_name,
       count(*) FILTER (
         WHERE organization_id IS NULL OR incident_id IS NULL
       ) AS null_rows,
       count(*) AS total_rows
  FROM analytics_events
UNION ALL
SELECT 'chat_messages',
       count(*) FILTER (
         WHERE organization_id IS NULL OR incident_id IS NULL
       ),
       count(*)
  FROM chat_messages
UNION ALL
SELECT 'contact_messages',
       count(*) FILTER (
         WHERE organization_id IS NULL OR incident_id IS NULL
       ),
       count(*)
  FROM contact_messages
UNION ALL
SELECT 'damage_candidates',
       count(*) FILTER (
         WHERE organization_id IS NULL OR incident_id IS NULL
       ),
       count(*)
  FROM damage_candidates
UNION ALL
SELECT 'report_confirmations',
       count(*) FILTER (
         WHERE organization_id IS NULL OR incident_id IS NULL
       ),
       count(*)
  FROM report_confirmations
UNION ALL
SELECT 'reports',
       count(*) FILTER (
         WHERE organization_id IS NULL OR incident_id IS NULL
       ),
       count(*)
  FROM reports
 ORDER BY table_name;
