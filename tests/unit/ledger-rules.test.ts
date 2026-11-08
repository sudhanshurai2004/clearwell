import { describe, expect, it } from "vitest";
import { assertBalanced, proportionalFeeReversal } from "../../src/modules/ledger/ledger.service";
import { Direction, type PostingLine } from "../../src/modules/ledger/ledger.types";

const line = (direction: Direction, amount: bigint): PostingLine => ({
  accountId: `acc-${direction}`,
  direction,
  amount,
});

describe("assertBalanced", () => {
  it("accepts a balanced posting", () => {
    expect(() =>
      assertBalanced([line(Direction.DEBIT, 1000n), line(Direction.CREDIT, 980n), line(Direction.CREDIT, 20n)]),
    ).not.toThrow();
  });

  it("rejects debits != credits", () => {
    expect(() => assertBalanced([line(Direction.DEBIT, 1000n), line(Direction.CREDIT, 999n)])).toThrow(
      /unbalanced/,
    );
  });

  it("rejects zero and negative amounts", () => {
    expect(() => assertBalanced([line(Direction.DEBIT, 0n), line(Direction.CREDIT, 0n)])).toThrow(
      /positive/,
    );
    expect(() => assertBalanced([line(Direction.DEBIT, -5n), line(Direction.CREDIT, -5n)])).toThrow(
      /positive/,
    );
  });

  it("rejects an empty posting", () => {
    expect(() => assertBalanced([])).toThrow(/at least one/);
  });

  it("rejects a total that does not match the declared amount", () => {
    expect(() => assertBalanced([line(Direction.DEBIT, 1000n), line(Direction.CREDIT, 1000n)], 900n)).toThrow(
      /does not match/,
    );
  });
});

describe("proportionalFeeReversal", () => {
  it("reverses the proportional share (floor)", () => {
    // fee 20 on 1000 captured; refund 500 -> floor(20*500/1000) = 10
    expect(
      proportionalFeeReversal({ fee: 20n, captured: 1000n, refund: 500n, alreadyRefunded: 0n, alreadyReversed: 0n }),
    ).toBe(10n);
    // floor(20*333/1000) = floor(6.66) = 6
    expect(
      proportionalFeeReversal({ fee: 20n, captured: 1000n, refund: 333n, alreadyRefunded: 0n, alreadyReversed: 0n }),
    ).toBe(6n);
  });

  it("returns the whole remaining fee on the final refund", () => {
    // 999 already refunded, 1 left, 18 of 20 fee already reversed
    expect(
      proportionalFeeReversal({
        fee: 20n,
        captured: 1000n,
        refund: 1n,
        alreadyRefunded: 999n,
        alreadyReversed: 18n,
      }),
    ).toBe(2n);
  });

  it("full refund nets everything to zero across three partial refunds", () => {
    const fee = 20n;
    const captured = 1000n;
    let alreadyRefunded = 0n;
    let alreadyReversed = 0n;

    for (const refund of [333n, 333n, 334n]) {
      const reversal = proportionalFeeReversal({
        fee,
        captured,
        refund,
        alreadyRefunded,
        alreadyReversed,
      });
      alreadyRefunded += refund;
      alreadyReversed += reversal;
    }

    expect(alreadyRefunded).toBe(captured);
    expect(alreadyReversed).toBe(fee); // no fee cents left behind
  });

  it("is clamped and never reverses more than the fee", () => {
    const reversal = proportionalFeeReversal({
      fee: 5n,
      captured: 100n,
      refund: 100n,
      alreadyRefunded: 0n,
      alreadyReversed: 0n,
    });
    expect(reversal).toBe(5n);
  });

  it("rejects refunds beyond the captured amount", () => {
    expect(() =>
      proportionalFeeReversal({ fee: 20n, captured: 1000n, refund: 500n, alreadyRefunded: 600n, alreadyReversed: 0n }),
    ).toThrow(/exceed/);
  });
});
