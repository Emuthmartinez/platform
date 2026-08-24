-- U8 verification for the campaign domain (0022).
-- Happy path after apply: every null_rows value is 0.

SELECT 'campaign_site_stewards' AS table_name,
       count(*) FILTER (
         WHERE organization_id IS NULL OR incident_id IS NULL
       ) AS null_rows,
       count(*) AS total_rows
  FROM campaign_site_stewards
UNION ALL
SELECT 'campaign_sites',
       count(*) FILTER (
         WHERE organization_id IS NULL OR incident_id IS NULL
       ),
       count(*)
  FROM campaign_sites
UNION ALL
SELECT 'material_pledges',
       count(*) FILTER (
         WHERE organization_id IS NULL OR incident_id IS NULL
       ),
       count(*)
  FROM material_pledges
UNION ALL
SELECT 'material_receipts',
       count(*) FILTER (
         WHERE organization_id IS NULL OR incident_id IS NULL
       ),
       count(*)
  FROM material_receipts
UNION ALL
SELECT 'material_shipments',
       count(*) FILTER (
         WHERE organization_id IS NULL OR incident_id IS NULL
       ),
       count(*)
  FROM material_shipments
 ORDER BY table_name;
