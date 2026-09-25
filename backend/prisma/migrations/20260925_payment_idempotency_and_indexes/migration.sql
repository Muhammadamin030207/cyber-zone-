-- Safe additive migration: no data loss, no destructive changes.
-- Purpose (spec §5, §14, §16, §35):
--   1) payments.idempotency_key — DB-level duplicate payment protection
--   2) query-path indexes for payments + bookings (scalability)

-- AlterTable: nullable column, existing rows untouched (NULLs allowed in Postgres unique index)
ALTER TABLE "payments" ADD COLUMN     "idempotency_key" TEXT;

-- CreateIndex: unique idempotency key (Postgres allows multiple NULLs)
CREATE UNIQUE INDEX "payments_idempotency_key_key" ON "payments"("idempotency_key");

-- CreateIndex: hot query paths
CREATE INDEX "payments_booking_id_status_idx" ON "payments"("booking_id", "status");
CREATE INDEX "payments_user_id_created_at_idx" ON "payments"("user_id", "created_at");
CREATE INDEX "payments_status_expires_at_idx" ON "payments"("status", "expires_at");
CREATE INDEX "bookings_room_id_date_idx" ON "bookings"("room_id", "date");
CREATE INDEX "bookings_computer_id_date_idx" ON "bookings"("computer_id", "date");
CREATE INDEX "bookings_user_id_created_at_idx" ON "bookings"("user_id", "created_at");
CREATE INDEX "bookings_status_created_at_idx" ON "bookings"("status", "created_at");
