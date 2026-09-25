import { expect } from "chai";
import { PublicKey } from "@solana/web3.js";
import {
  BUY_SOL,
  DISPUTE_WINDOW,
  Env,
  LAMPORTS_PER_SOL,
  SELL_SOL,
  USDC,
  alignedExpiry,
  expectErr,
  expectOk,
  nextNonce,
} from "./helpers";

const FIXED = 250n * USDC;
const EXPIRY = alignedExpiry(7);

describe("emergency_cancel", () => {
  let env: Env;
  beforeEach(async () => {
    env = new Env();
    await env.bootstrap();
  });

  async function open(
    product: any,
    amount: bigint,
    yieldAmount: bigint
  ): Promise<PublicKey> {
    const { res, position } = await env.openPosition({
      product,
      fixedPrice: FIXED,
      expiryTs: EXPIRY,
      amount,
      yieldAmount,
      nonce: nextNonce(),
    });
    expectOk(res);
    return position;
  }

  it("3 of 5 returns both legs on a Sell SOL position before expiry", async () => {
    const position = await open(SELL_SOL, 10n * LAMPORTS_PER_SOL, 1_000_000n);
    const userSol = env.sol(env.user.publicKey);
    const mmUsdc = env.usdcBalance(env.mm.publicKey);
    expectOk(await env.emergencyCancel(position, env.governance.slice(0, 3)));
    expect(env.sol(env.user.publicKey) - userSol).to.equal(
      10n * LAMPORTS_PER_SOL
    );
    expect(env.usdcBalance(env.mm.publicKey) - mmUsdc).to.equal(2500n * USDC);
    expect((await env.fetchPosition(position)).settled).to.be.true;
    expect(env.svm.getAccount(env.vault(position))).to.be.null;
  });

  it("3 of 5 returns both legs on a Buy SOL position, ignoring a posted price", async () => {
    const position = await open(BUY_SOL, 2500n * USDC, 40n * USDC);
    env.setTime(EXPIRY);
    expectOk(await env.postPrice(EXPIRY, 100n * USDC)); // would be "bought"
    env.setTime(EXPIRY + DISPUTE_WINDOW);
    const userUsdc = env.usdcBalance(env.user.publicKey);
    const mmSol = env.sol(env.mm.publicKey);
    expectOk(
      await env.emergencyCancel(position, [
        env.governance[0],
        env.governance[2],
        env.governance[4],
      ])
    );
    expect(env.usdcBalance(env.user.publicKey) - userUsdc).to.equal(
      2500n * USDC
    );
    expect(env.sol(env.mm.publicKey) - mmSol >= 10n * LAMPORTS_PER_SOL).to.be
      .true;
  });

  it("fails with 2 of 5 signers", async () => {
    const position = await open(SELL_SOL, 1n * LAMPORTS_PER_SOL, 1_000_000n);
    expectErr(
      await env.emergencyCancel(position, env.governance.slice(0, 2)),
      "InsufficientGovernanceSignatures"
    );
    expect((await env.fetchPosition(position)).settled).to.be.false;
  });

  it("fails if a non-governance signer is included", async () => {
    const position = await open(SELL_SOL, 1n * LAMPORTS_PER_SOL, 1_000_000n);
    expectErr(
      await env.emergencyCancel(position, [
        env.governance[0],
        env.governance[1],
        env.outsider,
      ]),
      "UnauthorizedGovernanceSigner"
    );
  });

  it("fails on an already-settled position", async () => {
    const position = await open(SELL_SOL, 1n * LAMPORTS_PER_SOL, 1_000_000n);
    expectOk(await env.emergencyCancel(position, env.governance.slice(0, 3)));
    expectErr(
      await env.emergencyCancel(position, env.governance.slice(0, 3)),
      "AlreadySettled"
    );
    env.setTime(EXPIRY);
    expectOk(await env.postPrice(EXPIRY, 300n * USDC));
    env.setTime(EXPIRY + DISPUTE_WINDOW);
    expectErr(await env.settle(position), "AlreadySettled");
  });
});
