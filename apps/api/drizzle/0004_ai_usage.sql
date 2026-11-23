CREATE TABLE "ai_usage_daily" (
	"user_id" text NOT NULL,
	"day" date NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"turns" bigint NOT NULL,
	"measured_turns" bigint NOT NULL,
	"input_tokens" bigint NOT NULL,
	"output_tokens" bigint NOT NULL,
	CONSTRAINT "ai_usage_daily_user_id_day_provider_model_pk" PRIMARY KEY("user_id","day","provider","model"),
	CONSTRAINT "ai_usage_daily_counts_check" CHECK ("ai_usage_daily"."turns" >= 0 and "ai_usage_daily"."measured_turns" between 0 and "ai_usage_daily"."turns" and "ai_usage_daily"."input_tokens" >= 0 and "ai_usage_daily"."output_tokens" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ai_usage_report" (
	"device_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_usage_report_device_id_batch_id_pk" PRIMARY KEY("device_id","batch_id")
);
--> statement-breakpoint
ALTER TABLE "ai_usage_daily" ADD CONSTRAINT "ai_usage_daily_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage_report" ADD CONSTRAINT "ai_usage_report_device_id_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."device"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_usage_daily_day_idx" ON "ai_usage_daily" USING btree ("day");--> statement-breakpoint
CREATE INDEX "ai_usage_report_received_at_idx" ON "ai_usage_report" USING btree ("received_at");