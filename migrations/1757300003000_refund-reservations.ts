import type { MigrationBuilder } from "node-pg-migrate";

/**
 * 0004 -- refund reservations
 *
 * THE PROBLEM THIS SOLVES (real double-charge scenario):
 *
 *   Two refund requests for the same captured payment arrive at the same time,
 *   for 400 each, with 500 captured. Both read captured=500, refunded=0, both
 *   conclude "400 <= 500, fine", both call the provider, the customer gets 800
 *   refunded on a 500 capture.
 *
 * A row lock alone does not help, because the provider call must happen OUTSIDE
 * the transaction (never hold a lock across the network). So we reserve the
 * amount locally first, in its own short transaction:
 *
 *   TX1  refundable = captured - refunded - reserved   -> reserve
 *   ---  provider refund (no lock held)
 *   TX2  release reservation, add to refunded, post the ledger entry
 *
 * `refund_reserved_minor` is that reservation. It is deliberately a column on
 * payments rather than a new status, so the client-visible state machine stays
 * exactly as designed (CAPTURED / PARTIALLY_REFUNDED / REFUNDED).
 *
 * If the process dies between the two transactions the reservation stays behind
 * and blocks further refunds. That is the SAFE direction to fail (we never
 * refund twice), and recovery clears stale reservations with a status inquiry
 * against the provider -- the sweeper's job in M7.
 */
export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    ALTER TABLE payments
      ADD COLUMN refund_reserved_minor bigint NOT NULL DEFAULT 0,
      ADD COLUMN refund_reserved_at    timestamptz;
  `);

  pgm.addConstraint("payments", "payments_refund_reserved_non_negative", {
    check: "refund_reserved_minor >= 0",
  });
  // A reservation is always paired with a timestamp, so stale ones are findable.
  pgm.addConstraint("payments", "payments_refund_reserved_pair", {
    check: "(refund_reserved_minor = 0 AND refund_reserved_at IS NULL) OR (refund_reserved_minor > 0 AND refund_reserved_at IS NOT NULL)",
  });
  // Refunded + reserved can never exceed what was captured. This is the
  // database-level version of the concurrency check above.
  pgm.addConstraint("payments", "payments_refund_total_within_captured", {
    check: "refunded_amount + refund_reserved_minor <= captured_amount",
  });

  pgm.createIndex("payments", "refund_reserved_at", {
    name: "payments_stale_reservation_idx",
    where: "refund_reserved_minor > 0",
  });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    ALTER TABLE payments
      DROP CONSTRAINT IF EXISTS payments_refund_total_within_captured,
      DROP CONSTRAINT IF EXISTS payments_refund_reserved_pair,
      DROP CONSTRAINT IF EXISTS payments_refund_reserved_non_negative,
      DROP COLUMN IF EXISTS refund_reserved_at,
      DROP COLUMN IF EXISTS refund_reserved_minor;
  `);
};
