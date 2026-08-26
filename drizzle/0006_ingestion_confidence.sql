ALTER TABLE "variants" ALTER COLUMN "price_paise" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "variants" ALTER COLUMN "stock" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "extraction" jsonb;