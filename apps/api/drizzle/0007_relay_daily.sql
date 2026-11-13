CREATE TABLE "relay_daily" (
	"day" date NOT NULL,
	"metric" text NOT NULL,
	"value" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "relay_daily_day_metric_pk" PRIMARY KEY("day","metric")
);
