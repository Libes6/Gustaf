CREATE TYPE "public"."announcement_level" AS ENUM('info', 'warning', 'critical');--> statement-breakpoint
CREATE TYPE "public"."client_kind" AS ENUM('desktop', 'mobile');--> statement-breakpoint
CREATE TYPE "public"."client_target" AS ENUM('all', 'desktop', 'mobile');--> statement-breakpoint
CREATE TYPE "public"."feature_flag_mode" AS ENUM('off', 'everyone', 'listed');--> statement-breakpoint
CREATE TABLE "announcement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"text_en" text NOT NULL,
	"text_ru" text NOT NULL,
	"level" "announcement_level" DEFAULT 'info' NOT NULL,
	"link" text,
	"target" "client_target" DEFAULT 'all' NOT NULL,
	"min_version" text,
	"max_version" text,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feature_flag" (
	"key" text PRIMARY KEY NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"mode" "feature_flag_mode" DEFAULT 'off' NOT NULL,
	"logins" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "minimum_version" (
	"kind" "client_kind" PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	"message" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
