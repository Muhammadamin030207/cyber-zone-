-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "PaymentEvidenceStatus" AS ENUM ('SUBMITTED', 'APPROVED', 'REJECTED');

-- AlterEnum
ALTER TYPE "PaymentMethod" ADD VALUE 'TRANSFER';

-- AlterTable
ALTER TABLE "bookings" ADD COLUMN     "approval_status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "approved_at" TIMESTAMP(3),
ADD COLUMN     "approved_by_id" TEXT,
ADD COLUMN     "auto_closed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "hold_expires_at" TIMESTAMP(3),
ADD COLUMN     "rejected_at" TIMESTAMP(3),
ADD COLUMN     "rejected_by_id" TEXT,
ADD COLUMN     "rejection_reason" TEXT,
ADD COLUMN     "session_ends_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "due_at" TIMESTAMP(3),
ADD COLUMN     "is_debt" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "payment_evidence" (
    "id" TEXT NOT NULL,
    "payment_id" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "uploaded_by_id" TEXT NOT NULL,
    "file_url" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "status" "PaymentEvidenceStatus" NOT NULL DEFAULT 'SUBMITTED',
    "review_note" TEXT,
    "reviewed_by_id" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payment_evidence_payment_id_created_at_idx" ON "payment_evidence"("payment_id", "created_at");

-- CreateIndex
CREATE INDEX "payment_evidence_status_created_at_idx" ON "payment_evidence"("status", "created_at");

-- CreateIndex
CREATE INDEX "payment_evidence_booking_id_idx" ON "payment_evidence"("booking_id");

-- CreateIndex
CREATE INDEX "bookings_approval_status_date_idx" ON "bookings"("approval_status", "date");

-- CreateIndex
CREATE INDEX "bookings_status_session_ends_at_idx" ON "bookings"("status", "session_ends_at");

-- CreateIndex
CREATE INDEX "payments_is_debt_status_idx" ON "payments"("is_debt", "status");

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_rejected_by_id_fkey" FOREIGN KEY ("rejected_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_evidence" ADD CONSTRAINT "payment_evidence_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_evidence" ADD CONSTRAINT "payment_evidence_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_evidence" ADD CONSTRAINT "payment_evidence_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_evidence" ADD CONSTRAINT "payment_evidence_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ============ BACKFILL (mavjud ma'lumotlarni buzmaslik uchun) ============
-- Avval allaqachon tasdiqlangan/pul to'langan bronlar "tasdiqlangan" deb
-- belgilanadi — aks holda eski foydalanuvchilar "Boshlash"ni bosolmasdi.
UPDATE "bookings"
SET "approval_status" = 'APPROVED',
    "approved_at" = COALESCE("session_started_at", "created_at")
WHERE "status" IN ('PARTIALLY_PAID', 'PAID', 'CONFIRMED', 'ACTIVE', 'COMPLETED');

-- Rad etilgan bronlar: tasdiqlanish so'ramagan bo'lsa REJECTED
UPDATE "bookings" b
SET "approval_status" = 'REJECTED'
WHERE b."status" = 'CANCELLED'
  AND NOT EXISTS (
    SELECT 1 FROM "payments" p
    WHERE p."booking_id" = b."id" AND p."status" IN ('PAID', 'COMPLETED')
  );

-- Faol (ACTIVE) sessiyalar uchun taymer chegarasi: sana + end_time
-- (Toshkent UTC+5). end_time 00:00 bo'lsa keyingi kun 00:00.
UPDATE "bookings" b
SET "session_ends_at" = (b."date"::timestamp + ((split_part(b."end_time", ':', 1)::int * 60 + split_part(b."end_time", ':', 2)::int) - 300) * interval '1 minute')
WHERE b."status" = 'ACTIVE'
  AND b."session_ended_at" IS NULL
  AND b."session_ends_at" IS NULL;

-- To'lov kutilayotgan bronlarda "band qilish" muddati = TTL dan keyingi vaqt
UPDATE "bookings"
SET "hold_expires_at" = "created_at" + interval '60 minutes'
WHERE "status" IN ('PENDING', 'PENDING_PAYMENT') AND "hold_expires_at" IS NULL;
