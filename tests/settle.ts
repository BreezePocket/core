import { expect } from "chai";
import { Keypair, PublicKey } from "@solana/web3.js";
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
const SELL_AMOUNT = 10n * LAMPORTS_PER_SOL; // 10 SOL
const SELL_YIELD = 12n * USDC; // yield is USDC for both products
const BUY_AMOUNT = 2500n * USDC; // buys 10 SOL at 250
const BUY_YIELD = 40n * USDC;

describe("settle", () => {
  let env: Env;
  beforeEach(async () => {
    env = new Env();
    await env.bootstrap();
  });

  async function openSell(): Promise<PublicKey> {
    const { res, position } = await env.openPosition({
      product: SELL_SOL,
      fixedPrice: FIXED,
      expiryTs: EXPIRY,
      amount: SELL_AMOUNT,
      yieldAmount: SELL_YIELD,
      nonce: nextNonce(),
    });
    expectOk(res);
    return position;
  }

  async function openBuy(): Promise<PublicKey> {
    const { res, position } = await env.openPosition({
      product: BUY_SOL,
      fixedPrice: FIXED,
      expiryTs: EXPIRY,
      amount: BUY_AMOUNT,
      yieldAmount: BUY_YIELD,
      nonce: nextNonce(),
    });
    expectOk(res);
    return position;
  }

  /** Post a poster price at expiry and move past the dispute window. */
  async function postAndWait(price: bigint) {
    env.setTime(EXPIRY);
    expectOk(await env.postPrice(EXPIRY, price));
    env.setTime(EXPIRY + DISPUTE_WINDOW);
  }

  function snapshot() {
    return {
      userSol: env.sol(env.user.publicKey),
      mmSol: env.sol(env.mm.publicKey),
      userUsdc: env.usdcBalance(env.user.publicKey),
      mmUsdc: env.usdcBalance(env.mm.publicKey),
    };
  }

  describe("guards", () => {
    it("fails before expiry with NotExpiredYet", async () => {
      const position = await openSell();
      expectOk(await env.postPrice(EXPIRY, 260n * USDC));
      env.setTime(EXPIRY - 1);
      expectErr(await env.settle(position), "NotExpiredYet");
    });

    it("fails with SettlementPriceMissing when nothing was posted", async () => {
      const position = await openSell();
      env.setTime(EXPIRY + DISPUTE_WINDOW);
      expectErr(await env.settle(position), "SettlementPriceMissing");
    });

    it("fails with SettlementPriceMismatch when the wrong price account is passed", async () => {
      const position = await openSell();
      const other = alignedExpiry(8);
      expectOk(await env.postPrice(other, 260n * USDC));
      env.setTime(EXPIRY + DISPUTE_WINDOW);
      expectErr(
        await env.settle(position, env.outsider, {
          settlementPrice: env.settlementPricePda(other),
        }),
        "SettlementPriceMismatch"
      );
    });

    it("fails inside the dispute window with DisputeWindowOpen", async () => {
      const position = await openSell();
      env.setTime(EXPIRY);
      expectOk(await env.postPrice(EXPIRY, 260n * USDC));
      env.setTime(EXPIRY + DISPUTE_WINDOW - 1);
      expectErr(await env.settle(position), "DisputeWindowOpen");
      env.setTime(EXPIRY + DISPUTE_WINDOW);
      expectOk(await env.settle(position));
    });

    it("fails on a second settle with AlreadySettled", async () => {
      const position = await openSell();
      await postAndWait(260n * USDC);
      expectOk(await env.settle(position));
      expectErr(await env.settle(position), "AlreadySettled");
    });

    it("rejects a wrong user or market maker account", async () => {
      const position = await openSell();
      await postAndWait(260n * USDC);
      const pos = await env.fetchPosition(position);
      const ix = await env.program.methods
        .settle()
        .accountsStrict({
          caller: env.outsider.publicKey,
          config: env.config,
          position,
          settlementPrice: env.settlementPricePda(EXPIRY),
          user: env.outsider.publicKey,
          marketMaker: pos.marketMaker,
          usdcMint: env.usdcMint.publicKey,
          positionUsdcVault: env.vault(position),
          userUsdcAta: env.ata(env.outsider.publicKey),
          mmUsdcAta: env.ata(pos.marketMaker),
          tokenProgram: new PublicKey(
            "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
          ),
          associatedTokenProgram: new PublicKey(
            "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
          ),
          systemProgram: new PublicKey("11111111111111111111111111111111"),
        })
        .instruction();
      expectErr(env.send([ix], [env.outsider]), "InvalidCounterparty");
    });
  });

  describe("Sell SOL outcomes", () => {
    it("kept: settlement price below fixed price returns SOL to user and USDC to MM", async () => {
      const position = await openSell();
      await postAndWait(240n * USDC);
      const before = snapshot();
      expectOk(await env.settle(position));
      const after = snapshot();
      expect(after.userSol - before.userSol).to.equal(SELL_AMOUNT);
      expect(after.userUsdc - before.userUsdc).to.equal(0n);
      expect(after.mmUsdc - before.mmUsdc).to.equal(2500n * USDC);
      // MM also gets the vault rent back.
      expect(after.mmSol > before.mmSol).to.be.true;
      expect(env.svm.getAccount(env.vault(position))).to.be.null;
      expect((await env.fetchPosition(position)).settled).to.be.true;
    });

    it("sold: settlement price at the fixed price gives user USDC and MM the SOL", async () => {
      const position = await openSell();
      await postAndWait(FIXED);
      const before = snapshot();
      expectOk(await env.settle(position));
      const after = snapshot();
      expect(after.userUsdc - before.userUsdc).to.equal(2500n * USDC);
      expect(after.userSol - before.userSol).to.equal(0n);
      expect(after.mmUsdc - before.mmUsdc).to.equal(0n);
      expect(after.mmSol - before.mmSol >= SELL_AMOUNT).to.be.true;
    });

    it("sold: settlement price above fixed price", async () => {
      const position = await openSell();
      await postAndWait(300n * USDC);
      const before = snapshot();
      expectOk(await env.settle(position));
      const after = snapshot();
      expect(after.userUsdc - before.userUsdc).to.equal(2500n * USDC);
      expect(after.mmSol - before.mmSol >= SELL_AMOUNT).to.be.true;
    });
  });

  describe("Buy SOL outcomes", () => {
    it("kept: settlement price above fixed price returns USDC to user and SOL to MM", async () => {
      const position = await openBuy();
      await postAndWait(260n * USDC);
      const before = snapshot();
      expectOk(await env.settle(position));
      const after = snapshot();
      expect(after.userUsdc - before.userUsdc).to.equal(BUY_AMOUNT);
      expect(after.userSol - before.userSol).to.equal(0n);
      expect(after.mmSol - before.mmSol >= 10n * LAMPORTS_PER_SOL).to.be.true;
      expect(after.mmUsdc - before.mmUsdc).to.equal(0n);
    });

    it("bought: settlement price at the fixed price gives user SOL and MM the USDC", async () => {
      const position = await openBuy();
      await postAndWait(FIXED);
      const before = snapshot();
      expectOk(await env.settle(position));
      const after = snapshot();
      expect(after.userSol - before.userSol).to.equal(10n * LAMPORTS_PER_SOL);
      expect(after.userUsdc - before.userUsdc).to.equal(0n);
      expect(after.mmUsdc - before.mmUsdc).to.equal(BUY_AMOUNT);
    });

    it("bought: settlement price below fixed price", async () => {
      const position = await openBuy();
      await postAndWait(200n * USDC);
      const before = snapshot();
      expectOk(await env.settle(position));
      const after = snapshot();
      expect(after.userSol - before.userSol).to.equal(10n * LAMPORTS_PER_SOL);
      expect(after.mmUsdc - before.mmUsdc).to.equal(BUY_AMOUNT);
    });
  });

  describe("permissionless and robust", () => {
    it("can be called by anyone, including the user", async () => {
      const position = await openSell();
      await postAndWait(240n * USDC);
      expectOk(await env.settle(position, env.user));
    });

    it("creates the MM's USDC account if it was closed, and forwards stray vault deposits to the MM", async () => {
      const position = await openSell();
      // Someone donates extra USDC into the vault after opening.
      const { createTransferInstruction } = await import("@solana/spl-token");
      expectOk(
        env.send(
          [
            createTransferInstruction(
              env.ata(env.user.publicKey),
              env.vault(position),
              env.user.publicKey,
              7n * USDC
            ),
          ],
          [env.user]
        )
      );
      await postAndWait(FIXED); // sold
      const before = snapshot();
      expectOk(await env.settle(position));
      const after = snapshot();
      expect(after.userUsdc - before.userUsdc).to.equal(2500n * USDC);
      expect(after.mmUsdc - before.mmUsdc).to.equal(7n * USDC);
    });

    it("settles immediately after a governance override with no dispute window", async () => {
      const position = await openSell();
      env.setTime(EXPIRY);
      expectOk(await env.postPrice(EXPIRY, 240n * USDC)); // would be kept
      env.setTime(EXPIRY + 60);
      expectErr(await env.settle(position), "DisputeWindowOpen");
      expectOk(
        await env.overridePrice(EXPIRY, 300n * USDC, env.governance.slice(2, 5))
      );
      const before = snapshot();
      expectOk(await env.settle(position)); // override price => sold
      const after = snapshot();
      expect(after.userUsdc - before.userUsdc).to.equal(2500n * USDC);
    });

    it("settles many positions at the same expiry independently", async () => {
      const sellPos = await openSell();
      const buyPos = await openBuy();
      const otherUser = Keypair.generate();
      env.svm.airdrop(otherUser.publicKey, 100n * LAMPORTS_PER_SOL);
      const { res, position: thirdPos } = await env.openPosition({
        product: SELL_SOL,
        fixedPrice: 200n * USDC,
        expiryTs: EXPIRY,
        amount: 1n * LAMPORTS_PER_SOL,
        yieldAmount: 1_000_000n,
        nonce: nextNonce(),
        user: otherUser,
      });
      expectOk(res);
      await postAndWait(FIXED);
      for (const p of [sellPos, buyPos, thirdPos])
        expectOk(await env.settle(p));
      expect((await env.fetchPosition(thirdPos)).settled).to.be.true;
      // 1 SOL sold at 200 => 200 USDC to the other user, on top of the 1 USDC upfront yield.
      expect(env.usdcBalance(otherUser.publicKey)).to.equal(201n * USDC);
    });
  });
});
