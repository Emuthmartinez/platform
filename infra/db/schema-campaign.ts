import {
  pgTable,
  text,
  doublePrecision,
  boolean,
  bigint,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { incidentOwnershipColumns, incidentOwnershipFk, tenantScopeIndex } from "./schema";

const epochMs = (name: string) => bigint(name, { mode: "number" });

export const DEFAULT_CAMPAIGN = "reconstruccion";

export const CAMPAIGN_SITE_STATUSES = ["active", "paused", "full", "closed"] as const;
export const PLEDGE_STATUSES = [
  "pledged",
  "received",
  "partial",
  "expired",
  "cancelled",
] as const;
export const SHIPMENT_STATUSES = ["loading", "in_transit", "delivered", "cancelled"] as const;

export interface MaterialLine {
  material: string;
  quantity: number;
  unit: string;
}

export const campaignSites = pgTable(
  "campaign_sites",
  {
    id: text("id").primaryKey(),
    campaign: text("campaign").notNull().default(DEFAULT_CAMPAIGN),
    name: text("name").notNull(),
    city: text("city").notNull(),
    address: text("address").notNull().default(""),
    lat: doublePrecision("lat"),
    lng: doublePrecision("lng"),
    schedule: text("schedule").notNull().default(""),
    publicContact: text("public_contact").notNull().default(""),
    accepts: jsonb("accepts").$type<string[]>().notNull().default([]),
    status: text("status").notNull().default("active"),
    note: text("note").notNull().default(""),
    createdAt: epochMs("created_at").notNull(),
    updatedAt: epochMs("updated_at"),
    ...incidentOwnershipColumns(),
  },
  (t) => [
    index("campaign_sites_campaign_idx").on(t.campaign, t.status),
    index("campaign_sites_city_idx").on(t.city),
    incidentOwnershipFk("campaign_sites", t),
    tenantScopeIndex("campaign_sites", t),
  ],
);

export const campaignSiteStewards = pgTable(
  "campaign_site_stewards",
  {
    id: text("id").primaryKey(),
    siteId: text("site_id")
      .notNull()
      .references(() => campaignSites.id, { onDelete: "cascade" }),
    displayName: text("display_name").notNull().default("Responsable de punto"),
    accessTokenHash: text("access_token_hash").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: epochMs("created_at").notNull(),
    updatedAt: epochMs("updated_at"),
    ...incidentOwnershipColumns(),
  },
  (t) => [
    index("campaign_site_stewards_site_idx").on(t.siteId, t.active),
    index("campaign_site_stewards_token_idx").on(t.accessTokenHash, t.active),
    incidentOwnershipFk("campaign_site_stewards", t),
    tenantScopeIndex("campaign_site_stewards", t),
  ],
);

export const materialPledges = pgTable(
  "material_pledges",
  {
    id: text("id").primaryKey(),
    campaign: text("campaign").notNull().default(DEFAULT_CAMPAIGN),
    code: text("code").notNull().unique(),
    siteId: text("site_id").references(() => campaignSites.id, { onDelete: "set null" }),
    donorName: text("donor_name").notNull(),
    donorContact: text("donor_contact").notNull().default(""),
    publicAlias: text("public_alias"),
    items: jsonb("items").$type<MaterialLine[]>().notNull(),
    status: text("status").notNull().default("pledged"),
    expectedAt: epochMs("expected_at"),
    note: text("note").notNull().default(""),
    /**
     * Foto que adjunta quien dona. Uso INTERNO: no sale por ningún endpoint
     * público, ni siquiera en el certificado. Guarda una URL del CDN cuando R2
     * está configurado, y un data-URL cuando no (mismo trato que las demás
     * fotos del proyecto, ver lib/r2.ts).
     */
    photo: text("photo"),
    source: text("source").notNull().default("web"),
    ipHash: text("ip_hash"),
    createdAt: epochMs("created_at").notNull(),
    updatedAt: epochMs("updated_at"),
    ...incidentOwnershipColumns(),
  },
  (t) => [
    index("material_pledges_campaign_idx").on(t.campaign, t.status),
    index("material_pledges_site_idx").on(t.siteId, t.status),
    incidentOwnershipFk("material_pledges", t),
    tenantScopeIndex("material_pledges", t),
  ],
);

export const materialReceipts = pgTable(
  "material_receipts",
  {
    id: text("id").primaryKey(),
    pledgeId: text("pledge_id").references(() => materialPledges.id, { onDelete: "set null" }),
    siteId: text("site_id")
      .notNull()
      .references(() => campaignSites.id, { onDelete: "cascade" }),
    stewardId: text("steward_id").references(() => campaignSiteStewards.id, {
      onDelete: "set null",
    }),
    items: jsonb("items").$type<MaterialLine[]>().notNull(),
    note: text("note").notNull().default(""),
    /** Foto del material al recibirlo. Uso interno, igual que en el compromiso. */
    photo: text("photo"),
    receivedAt: epochMs("received_at").notNull(),
    createdAt: epochMs("created_at").notNull(),
    ...incidentOwnershipColumns(),
  },
  (t) => [
    index("material_receipts_site_idx").on(t.siteId, t.receivedAt),
    index("material_receipts_pledge_idx").on(t.pledgeId),
    incidentOwnershipFk("material_receipts", t),
    tenantScopeIndex("material_receipts", t),
  ],
);

export const materialShipments = pgTable(
  "material_shipments",
  {
    id: text("id").primaryKey(),
    campaign: text("campaign").notNull().default(DEFAULT_CAMPAIGN),
    code: text("code").notNull().unique(),
    originSiteId: text("origin_site_id").references(() => campaignSites.id, {
      onDelete: "set null",
    }),
    originCity: text("origin_city").notNull().default(""),
    destName: text("dest_name").notNull(),
    destLat: doublePrecision("dest_lat"),
    destLng: doublePrecision("dest_lng"),
    carrierNote: text("carrier_note").notNull().default(""),
    items: jsonb("items").$type<MaterialLine[]>().notNull(),
    status: text("status").notNull().default("loading"),
    departedAt: epochMs("departed_at"),
    arrivedAt: epochMs("arrived_at"),
    createdAt: epochMs("created_at").notNull(),
    updatedAt: epochMs("updated_at"),
    ...incidentOwnershipColumns(),
  },
  (t) => [
    index("material_shipments_campaign_idx").on(t.campaign, t.status),
    incidentOwnershipFk("material_shipments", t),
    tenantScopeIndex("material_shipments", t),
  ],
);
