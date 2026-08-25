CREATE TABLE "platform_audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_operator_id" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"metadata" jsonb,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_deployment_specs" (
	"key" text PRIMARY KEY NOT NULL,
	"organization_key" text NOT NULL,
	"incident_key" text NOT NULL,
	"hostname" text NOT NULL,
	"lifecycle" text DEFAULT 'preview' NOT NULL,
	"provisioning_run_id" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_operators" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"password_hash" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" bigint NOT NULL,
	"last_login_at" bigint
);
--> statement-breakpoint
CREATE TABLE "platform_provisioning_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"plan_digest" text NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"desired_state" jsonb NOT NULL,
	"plan" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"approved_by" text,
	"created_at" bigint NOT NULL,
	"approved_at" bigint,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_provisioning_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"key" text NOT NULL,
	"ordinal" integer NOT NULL,
	"execution" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"detail" jsonb,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_platform_audit_created" ON "platform_audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_platform_specs_hostname" ON "platform_deployment_specs" USING btree ("hostname");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_platform_operators_email" ON "platform_operators" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "idx_platform_runs_digest" ON "platform_provisioning_runs" USING btree ("plan_digest");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_platform_steps_run_key" ON "platform_provisioning_steps" USING btree ("run_id","key");--> statement-breakpoint
CREATE INDEX "idx_platform_steps_run_ordinal" ON "platform_provisioning_steps" USING btree ("run_id","ordinal");