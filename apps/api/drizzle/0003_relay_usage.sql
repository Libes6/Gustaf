CREATE TABLE "relay_usage" (
	"user_id" text NOT NULL,
	"month" text NOT NULL,
	"bytes" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "relay_usage_user_id_month_pk" PRIMARY KEY("user_id","month")
);
--> statement-breakpoint
ALTER TABLE "relay_usage" ADD CONSTRAINT "relay_usage_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;