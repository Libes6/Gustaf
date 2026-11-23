CREATE TYPE "public"."bug_report_client" AS ENUM('desktop', 'mobile');--> statement-breakpoint
CREATE TYPE "public"."bug_report_status" AS ENUM('new', 'seen', 'closed');--> statement-breakpoint
CREATE TABLE "bug_report" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"device_id" uuid,
	"client" "bug_report_client" NOT NULL,
	"app_version" text NOT NULL,
	"platform" text NOT NULL,
	"message" text NOT NULL,
	"logs" text,
	"status" "bug_report_status" DEFAULT 'new' NOT NULL,
	"admin_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bug_report" ADD CONSTRAINT "bug_report_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bug_report" ADD CONSTRAINT "bug_report_device_id_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."device"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bug_report_status_created_at_idx" ON "bug_report" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "bug_report_user_id_created_at_idx" ON "bug_report" USING btree ("user_id","created_at");