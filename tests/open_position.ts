import { expect } from "chai";
import { Keypair, Transaction } from "@solana/web3.js";
import {
  BUY_SOL,
  Env,
  LAMPORTS_PER_SOL,
  NOW,
  SELL_SOL,
  USDC,
  alignedExpiry,
  expectErr,
  expectOk,
  nextNonce,
} from "./helpers";

const FIXED = 250n * USDC; // 250 USDC per SOL
const EXPIRY = alignedExpiry(7);

describe("open_position", () => {
  let env: Env;
  beforeEach(async () => {
    env = new Env();
    await env.bootstrap();
  });

  const base = () => ({
    product: SELL_SOL,
    fixedPrice: FIXED,
    expiryTs: EXPIRY,
    amount: 10n * LAMPORTS_PER_SOL,
    // Both products pay the premium in USDC.
    yieldAmount: 12n * USDC,
    nonce: nextNonce(),
  });

  describe("guards", () => {
    it("rejects an expiry in the past", async () => {
      const { res } = await env.openPosition({
        ...base(),
        expiryTs: alignedExpiry(-1),
      });
      expectErr(res, "ExpiryInPast");
    });

    it("rejects an expiry that is not 08:00 UTC", async () => {
      const { res } = await env.openPosition({
        ...base(),
        expiryTs: EXPIRY + 60,
      });
      expectErr(res, "ExpiryNotAligned");
    });

    it("rejects a zero fixed price", async () => {
      const { res } = await env.openPosition({ ...base(), fixedPrice: 0n });
      expectErr(res, "InvalidFixedPrice");
    });

    it("rejects a zero amount", async () => {
      const { res } = await env.openPosition({ ...base(), amount: 0n });
      expectErr(res, "InvalidAmount");
    });

    it("rejects a zero yield", async () => {
      const { res } = await env.openPosition({ ...base(), yieldAmount: 0n });
      expectErr(res, "InvalidYield");
    });

    it("rejects user == market maker", async () => {
      const { res } = await env.openPosition({ ...base(), user: env.mm });
      expectErr(res, "SameCounterparty");
    });

    it("rejects a USDC mint that differs from GlobalConfig", async () => {
      const other = Keypair.generate();
      // Create a second mint and fund both parties on it so only the mint check fails.
      const saved = env.usdcMint;
      env.usdcMint = other;
      env.createUsdcMint();
      env.mintUsdc(env.mm.publicKey, 1000n * USDC);
      env.mintUsdc(env.user.publicKey, 1000n * USDC);
      env.usdcMint = saved;
      const { res } = await env.openPosition({
        ...base(),
        usdcMint: other.publicKey,
      });
      expectErr(res, "InvalidUsdcMint");
    });

    it("fails without the market maker signature", async () => {
      const { ix } = await env.openPositionIx(base());
      const tx = new Transaction();
      tx.recentBlockhash = env.svm.latestBlockhash();
      tx.feePayer = env.mm.publicKey;
      tx.add(ix);
      tx.partialSign(env.user);
      expect(tx.signatures.some((s) => s.signature === null)).to.be.true;
      let threw = false;
      try {
        env.sendRaw(tx);
      } catch {
        threw = true;
      }
      expect(threw, "unsigned MM slot must be rejected").to.be.true;
    });

    it("fails without the user signature", async () => {
      const { ix } = await env.openPositionIx(base());
      const tx = new Transaction();
      tx.recentBlockhash = env.svm.latestBlockhash();
      tx.feePayer = env.mm.publicKey;
      tx.add(ix);
      tx.partialSign(env.mm);
      let threw = false;
      try {
        env.sendRaw(tx);
      } catch {
        threw = true;
      }
      expect(threw, "unsigned user slot must be rejected").to.be.true;
    });

    it("fails when the market maker cannot cover its leg", async () => {
      const poorMm = Keypair.generate();
      env.svm.airdrop(poorMm.publicKey, 5n * LAMPORTS_PER_SOL);
      env.mintUsdc(poorMm.publicKey, 1n * USDC);
      const { res } = await env.openPosition({ ...base(), mm: poorMm });
      expectErr(res, "insufficient funds");
    });
  });

  describe("Sell SOL happy path", () => {
    it("locks user SOL, MM USDC and pays yield in USDC, with MM as fee payer", async () => {
      const p = base();
      const userSolBefore = env.sol(env.user.publicKey);
      const mmSolBefore = env.sol(env.mm.publicKey);
      const mmUsdcBefore = env.usdcBalance(env.mm.publicKey);
      const userUsdcBefore = env.usdcBalance(env.user.publicKey);

      const { res, position } = await env.openPosition(p);
      expectOk(res);

      const pos = await env.fetchPosition(position);
      expect(pos.user.equals(env.user.publicKey)).to.be.true;
      expect(pos.marketMaker.equals(env.mm.publicKey)).to.be.true;
      expect(pos.product).to.deep.equal({ sellSol: {} });
      expect(pos.token).to.deep.equal({ sol: {} });
      expect(BigInt(pos.userCollateral.toString())).to.equal(p.amount);
      // 10 SOL * 250 USDC = 2500 USDC
      expect(BigInt(pos.mmCollateral.toString())).to.equal(2500n * USDC);
      expect(BigInt(pos.yieldAmount.toString())).to.equal(p.yieldAmount);
      expect(pos.settled).to.be.false;

      // User: -amount SOL, +yield USDC, no fees.
      expect(env.sol(env.user.publicKey)).to.equal(userSolBefore - p.amount);
      expect(env.usdcBalance(env.user.publicKey)).to.equal(
        userUsdcBefore + p.yieldAmount
      );
      // MM paid the fee and rent for position + vault (+ nothing for the user ATA, which exists).
      expect(env.sol(env.mm.publicKey) < mmSolBefore).to.be.true;
      // MM USDC: the payment leg plus the yield.
      expect(env.usdcBalance(env.mm.publicKey)).to.equal(
        mmUsdcBefore - 2500n * USDC - p.yieldAmount
      );
      expect(env.tokenAccountBalance(env.vault(position))).to.equal(
        2500n * USDC
      );
      // Position holds rent + user collateral.
      const rent = env.svm.minimumBalanceForRentExemption(
        BigInt(env.svm.getAccount(position)!.data.length)
      );
      expect(env.sol(position)).to.equal(rent + p.amount);
    });

    it("creates the user's USDC account when missing", async () => {
      const freshUser = Keypair.generate();
      env.svm.airdrop(freshUser.publicKey, 100n * LAMPORTS_PER_SOL);
      expect(env.svm.getAccount(env.ata(freshUser.publicKey))).to.be.null;
      const { res } = await env.openPosition({ ...base(), user: freshUser });
      expectOk(res);
      // The account exists and holds the upfront yield.
      expect(env.usdcBalance(freshUser.publicKey)).to.equal(base().yieldAmount);
      expect(env.svm.getAccount(env.ata(freshUser.publicKey))).to.not.be.null;
    });
  });

  describe("Buy SOL happy path", () => {
    it("locks user USDC, MM SOL and pays yield in USDC", async () => {
      const p = {
        ...base(),
        product: BUY_SOL,
        amount: 2500n * USDC, // 2500 USDC buys 10 SOL at 250
        yieldAmount: 40n * USDC,
      };
      const userUsdcBefore = env.usdcBalance(env.user.publicKey);
      const mmUsdcBefore = env.usdcBalance(env.mm.publicKey);
      const userSolBefore = env.sol(env.user.publicKey);

      const { res, position } = await env.openPosition(p);
      expectOk(res);

      const pos = await env.fetchPosition(position);
      expect(pos.product).to.deep.equal({ buySol: {} });
      expect(pos.token).to.deep.equal({ usdc: {} });
      expect(BigInt(pos.userCollateral.toString())).to.equal(p.amount);
      expect(BigInt(pos.mmCollateral.toString())).to.equal(
        10n * LAMPORTS_PER_SOL
      );

      expect(env.usdcBalance(env.user.publicKey)).to.equal(
        userUsdcBefore - p.amount + p.yieldAmount
      );
      expect(env.usdcBalance(env.mm.publicKey)).to.equal(
        mmUsdcBefore - p.yieldAmount
      );
      expect(env.tokenAccountBalance(env.vault(position))).to.equal(p.amount);
      expect(env.sol(env.user.publicKey)).to.equal(userSolBefore);
      const rent = env.svm.minimumBalanceForRentExemption(
        BigInt(env.svm.getAccount(position)!.data.length)
      );
      expect(env.sol(position)).to.equal(rent + 10n * LAMPORTS_PER_SOL);
    });
  });

  describe("replay protection", () => {
    it("rejects the same params twice and accepts a fresh nonce", async () => {
      const p = base();
      expectOk((await env.openPosition(p)).res);
      expectErr((await env.openPosition(p)).res, "already in use");
      expectOk((await env.openPosition({ ...p, nonce: nextNonce() })).res);
    });

    it("rejects an identical signed transaction re-submitted", async () => {
      const { ix } = await env.openPositionIx(base());
      const tx = new Transaction();
      tx.recentBlockhash = env.svm.latestBlockhash();
      tx.feePayer = env.mm.publicKey;
      tx.add(ix);
      tx.sign(env.mm, env.user);
      expectOk(env.svm.sendTransaction(tx));
      const again = env.svm.sendTransaction(tx);
      expect(again.constructor.name).to.equal("FailedTransactionMetadata");
    });
  });

  it("keeps the dual-signed transaction well under the 1232-byte limit", async () => {
    const { ix } = await env.openPositionIx(base());
    const tx = new Transaction();
    tx.recentBlockhash = env.svm.latestBlockhash();
    tx.feePayer = env.mm.publicKey;
    tx.add(ix);
    tx.sign(env.mm, env.user);
    const size = tx.serialize().length;
    expect(size < 1232).to.be.true;
    expect(size < 800).to.be.true;
  });

  it("uses the on-chain clock for the expiry check", async () => {
    env.setTime(EXPIRY + 1);
    const { res } = await env.openPosition(base());
    expectErr(res, "ExpiryInPast");
    env.setTime(NOW);
  });
});
