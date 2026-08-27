CREATE TABLE "platform_operator_grants" (
	"operator_id" text NOT NULL,
	"capability_key" text NOT NULL,
	"granted_by" text NOT NULL,
	"granted_at" bigint NOT NULL,
	"revoked_by" text,
	"revoked_at" bigint,
	"reason" text DEFAULT '' NOT NULL,
	CONSTRAINT "platform_operator_grants_operator_id_capability_key_pk" PRIMARY KEY("operator_id","capability_key"),
	CONSTRAINT "platform_operator_grants_revocation_check" CHECK (("platform_operator_grants"."revoked_by" IS NULL AND "platform_operator_grants"."revoked_at" IS NULL) OR ("platform_operator_grants"."revoked_by" IS NOT NULL AND "platform_operator_grants"."revoked_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "platform_operators" ADD COLUMN "access_subject" text;--> statement-breakpoint
ALTER TABLE "platform_operator_grants" ADD CONSTRAINT "platform_operator_grants_operator_id_platform_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."platform_operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_operator_grants" ADD CONSTRAINT "platform_operator_grants_granted_by_platform_operators_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."platform_operators"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_operator_grants" ADD CONSTRAINT "platform_operator_grants_revoked_by_platform_operators_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."platform_operators"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_platform_operator_grants_active" ON "platform_operator_grants" USING btree ("operator_id","revoked_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_platform_operators_access_subject" ON "platform_operators" USING btree ("access_subject");--> statement-breakpoint
-- Preserve the authority of operators created before capability enforcement.
-- Future operators are deny-by-default and receive only explicit grants.
INSERT INTO "platform_operator_grants" (
	"operator_id", "capability_key", "granted_by", "granted_at", "reason"
)
SELECT
	o."id",
	c."capability_key",
	o."id",
	(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint,
	'Backfill existing platform operator authority'
FROM "platform_operators" o
CROSS JOIN unnest(ARRAY[
	'platform:portfolio:read',
	'platform:provisioning:read',
	'platform:provisioning:plan',
	'platform:provisioning:approve',
	'platform:provisioning:apply',
	'platform:operators:manage',
	'platform:audit:read'
]) AS c("capability_key")
ON CONFLICT DO NOTHING;
