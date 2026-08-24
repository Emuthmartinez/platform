-- U8 tighten (KTD6 steps 4-6). Incident-scoped tables from the backfill
-- manifest. audit_log is mixed-scope and is not in this migration.
--
-- The ops runner (ops:tighten) should VALIDATE FKs and pre-create
-- tenant-leading indexes CONCURRENTLY on populated databases before this
-- file runs inside migrate.ts (3s lock_timeout / 60s statement_timeout).
-- Local/empty databases apply this file alone.
--
-- CREATE INDEX CONCURRENTLY is forbidden here.

DO $tighten$
DECLARE
  t text;
  tables text[] := ARRAY[
    'analytics_events',
    'api_keys',
    'campaign_site_stewards',
    'campaign_sites',
    'chat_messages',
    'click_counter_dedup',
    'click_counters',
    'contact_messages',
    'damage_candidates',
    'data_deletion_requests',
    'donations',
    'failed_submissions',
    'hospital_patients',
    'hospital_poc_assignments',
    'hospital_supply_events',
    'hospital_supply_help_requests',
    'hospital_supply_needs',
    'hospital_supply_statuses',
    'hospitals',
    'hub_checkins',
    'hub_credentials',
    'hub_damaged_buildings',
    'hub_help_offers',
    'hub_help_requests',
    'hub_missing_persons',
    'hub_sync_state',
    'material_pledges',
    'material_receipts',
    'material_shipments',
    'missing_person_suppressions',
    'missing_persons',
    'missing_pets',
    'ocr_corrections',
    'official_deceased_lists',
    'official_deceased_records',
    'patient_import_rows',
    'patient_imports',
    'person_cluster_members',
    'person_clusters',
    'person_link_decisions',
    'person_links',
    'person_records',
    'record_status_signals',
    'report_confirmations',
    'reports',
    'unidentified_persons',
    'volunteer_assignments',
    'volunteer_checkins',
    'volunteer_tasks',
    'volunteers'
  ];
  org_nn boolean;
  incident_nn boolean;
BEGIN
  FOREACH t IN ARRAY tables LOOP
    SELECT a.attnotnull INTO STRICT org_nn
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = t AND a.attname = 'organization_id'
       AND a.attnum > 0 AND NOT a.attisdropped;
    SELECT a.attnotnull INTO STRICT incident_nn
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = t AND a.attname = 'incident_id'
       AND a.attnum > 0 AND NOT a.attisdropped;

    IF NOT org_nn THEN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = t || '_organization_id_nn'
      ) THEN
        EXECUTE format(
          'ALTER TABLE %I ADD CONSTRAINT %I CHECK (organization_id IS NOT NULL) NOT VALID',
          t, t || '_organization_id_nn'
        );
      END IF;
      EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I', t, t || '_organization_id_nn');
      EXECUTE format('ALTER TABLE %I ALTER COLUMN organization_id SET NOT NULL', t);
    END IF;
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', t, t || '_organization_id_nn');

    IF NOT incident_nn THEN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = t || '_incident_id_nn'
      ) THEN
        EXECUTE format(
          'ALTER TABLE %I ADD CONSTRAINT %I CHECK (incident_id IS NOT NULL) NOT VALID',
          t, t || '_incident_id_nn'
        );
      END IF;
      EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I', t, t || '_incident_id_nn');
      EXECUTE format('ALTER TABLE %I ALTER COLUMN incident_id SET NOT NULL', t);
    END IF;
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', t, t || '_incident_id_nn');

    EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I', t, t || '_incident_ownership_fk');
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON %I USING btree (organization_id, incident_id)',
      t || '_tenant_scope_idx', t
    );
  END LOOP;
END
$tighten$;
