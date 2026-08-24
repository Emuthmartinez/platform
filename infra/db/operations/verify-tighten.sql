-- U8 tighten verification. Happy path: is_nullable = NO, fk validated,
-- tenant-leading index valid. audit_log is intentionally absent.

SELECT c.relname AS table_name,
       bool_and(a.attname = 'organization_id' AND a.attnotnull)
         FILTER (WHERE a.attname = 'organization_id') AS org_not_null,
       bool_and(a.attname = 'incident_id' AND a.attnotnull)
         FILTER (WHERE a.attname = 'incident_id') AS incident_not_null
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid
 WHERE n.nspname = 'public'
   AND c.relname IN (
     'analytics_events', 'api_keys', 'campaign_site_stewards', 'campaign_sites',
     'chat_messages', 'click_counter_dedup', 'click_counters', 'contact_messages',
     'damage_candidates', 'data_deletion_requests', 'donations', 'failed_submissions',
     'hospital_patients', 'hospital_poc_assignments', 'hospital_supply_events',
     'hospital_supply_help_requests', 'hospital_supply_needs', 'hospital_supply_statuses',
     'hospitals', 'hub_checkins', 'hub_credentials', 'hub_damaged_buildings',
     'hub_help_offers', 'hub_help_requests', 'hub_missing_persons', 'hub_sync_state',
     'material_pledges', 'material_receipts', 'material_shipments',
     'missing_person_suppressions', 'missing_persons', 'missing_pets',
     'ocr_corrections', 'official_deceased_lists', 'official_deceased_records',
     'patient_import_rows', 'patient_imports', 'person_cluster_members',
     'person_clusters', 'person_link_decisions', 'person_links', 'person_records',
     'record_status_signals', 'report_confirmations', 'reports',
     'unidentified_persons', 'volunteer_assignments', 'volunteer_checkins',
     'volunteer_tasks', 'volunteers'
   )
   AND a.attname IN ('organization_id', 'incident_id')
   AND a.attnum > 0 AND NOT a.attisdropped
 GROUP BY c.relname
 ORDER BY c.relname;
