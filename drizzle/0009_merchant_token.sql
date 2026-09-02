ALTER TABLE "merchants" ADD COLUMN "token" text;--> statement-breakpoint
CREATE UNIQUE INDEX "merchants_token_idx" ON "merchants" USING btree ("token");