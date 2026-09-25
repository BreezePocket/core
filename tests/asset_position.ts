import { expect } from "chai";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  ASSET,
  AssetEnv,
  BUY_SOL,
  DISPUTE_WINDOW,
  SELL_SOL,
  US_CLOSE,
  USDC,
  alignedExpiry,
  alignedExpiryAt,
  expectErr,
  expectOk,
  nextNonce,
} from "./helpers";

const FIXED = 180n * USDC; // 180 USDC per token
const EXPIRY = alignedExpiryAt(7, US_CLOSE);
const SELL_AMOUNT = 10n * ASSET;
const SELL_YIELD = 12n * USDC; // yield is USDC for both products
const BUY_AMOUNT = 1800n * USDC; // buys 10 tokens at 180
const BUY_YIELD = 25n * USDC;

describe("list_asset", () => {
  let env: AssetEnv;
  beforeEach(async () => {
    env = new AssetEnv();
    await env.bootstrap();
    env.createMint(env.assetMint, 9);
  });

  it("stores mint, symbol, decimals and expiry time with 3 governance signers", async () => {
    expectOk(
      await env.listAsset(env.mint, "NVDAon", US_CLOSE, env.governance.slice(2))
    );
    const acc = env.svm.getAccount(env.assetPda())!;
    const a = env.program.coder.accounts.decode(
      "assetConfig",
      Buffer.from(acc.data)
    );
    expect(a.mint.equals(env.mint)).to.be.true;
    expect(a.symbol).to.equal("NVDAon");
    expect(a.decimals).to.equal(9);
    expect(a.expiryTimeOfDay.toNumber()).to.equal(US_CLOSE);
  });

  it("needs 3 of 5 governance keys", async () => {
    expectErr(
      await env.listAsset(env.mint, "NVDAon", US_CLOSE, env.governance.slice(0, 2)),
      "InsufficientGovernanceSignatures"
    );
    expectErr(
      await env.listAsset(env.mint, "NVDAon", US_CLOSE, [
        ...env.governance.slice(0, 3),
        env.user,
      ]),
      "UnauthorizedGovernanceSigner"
    );
  });

  it("rejects USDC, bad symbols, bad times of day, and a second listing", async () => {
    const gov = env.governance.slice(0, 3);
    expectErr(
      await env.listAsset(env.usdcMint.publicKey, "USDC", US_CLOSE, gov),
      "AssetIsUsdc"
    );
    expectErr(await env.listAsset(env.mint, "", US_CLOSE, gov), "InvalidSymbol");
    expectErr(
      await env.listAsset(env.mint, "NVDA on", US_CLOSE, gov),
      "InvalidSymbol"
    );
    expectErr(
      await env.listAsset(env.mint, "A".repeat(17), US_CLOSE, gov),
      "InvalidSymbol"
    );
    expectErr(
      await env.listAsset(env.mint, "NVDAon", 86_400, gov),
      "InvalidExpiryTimeOfDay"
    );
    expectOk(await env.listAsset(env.mint, "NVDAon", US_CLOSE, gov));
    expectErr(
      await env.listAsset(env.mint, "NVDAon", US_CLOSE, gov),
      "already in use"
    );
  });
});

describe("open_asset_position", () => {
  let env: AssetEnv;
  beforeEach(async () => {
    env = new AssetEnv();
    await env.bootstrapAsset();
  });

  const sell = () => ({
    product: SELL_SOL,
    fixedPrice: FIXED,
    expiryTs: EXPIRY,
    amount: SELL_AMOUNT,
    yieldAmount: SELL_YIELD,
    nonce: nextNonce(),
  });
  const buy = () => ({
    product: BUY_SOL,
    fixedPrice: FIXED,
    expiryTs: EXPIRY,
    amount: BUY_AMOUNT,
    yieldAmount: BUY_YIELD,
    nonce: nextNonce(),
  });

  it("sell: locks the user's tokens and the MM's USDC, pays yield in USDC", async () => {
    const userTok = env.tokenBalance(env.mint, env.user.publicKey);
    const mmTok = env.tokenBalance(env.mint, env.mm.publicKey);
    const userUsdc = env.usdcBalance(env.user.publicKey);
    const mmUsdc = env.usdcBalance(env.mm.publicKey);
    const { res, position } = await env.openAssetPosition(sell());
    expectOk(res);

    const pos = await env.fetchAssetPosition(position);
    expect(pos.assetMint.equals(env.mint)).to.be.true;
    expect(pos.product).to.deep.equal({ sellSol: {} });
    expect(BigInt(pos.userCollateral.toString())).to.equal(SELL_AMOUNT);
    expect(BigInt(pos.mmCollateral.toString())).to.equal(1800n * USDC);
    expect(pos.settled).to.be.false;

    expect(env.tokenBalance(env.mint, env.user.publicKey)).to.equal(
      userTok - SELL_AMOUNT
    );
    expect(env.tokenBalance(env.mint, env.mm.publicKey)).to.equal(mmTok);
    expect(env.usdcBalance(env.user.publicKey)).to.equal(userUsdc + SELL_YIELD);
    expect(env.usdcBalance(env.mm.publicKey)).to.equal(
      mmUsdc - 1800n * USDC - SELL_YIELD
    );
    expect(env.tokenBalance(env.mint, position)).to.equal(SELL_AMOUNT);
    expect(env.usdcBalance(position)).to.equal(1800n * USDC);
  });

  it("buy: locks the user's USDC and the MM's tokens, pays yield in USDC", async () => {
    const userUsdc = env.usdcBalance(env.user.publicKey);
    const mmTok = env.tokenBalance(env.mint, env.mm.publicKey);
    const { res, position } = await env.openAssetPosition(buy());
    expectOk(res);

    const pos = await env.fetchAssetPosition(position);
    expect(BigInt(pos.mmCollateral.toString())).to.equal(10n * ASSET);
    expect(env.usdcBalance(env.user.publicKey)).to.equal(
      userUsdc - BUY_AMOUNT + BUY_YIELD
    );
    expect(env.tokenBalance(env.mint, env.mm.publicKey)).to.equal(
      mmTok - 10n * ASSET
    );
    expect(env.tokenBalance(env.mint, position)).to.equal(10n * ASSET);
    expect(env.usdcBalance(position)).to.equal(BUY_AMOUNT);
  });

  it("creates the user's token accounts when missing", async () => {
    const fresh = Keypair.generate();
    env.svm.airdrop(fresh.publicKey, 10n * 1_000_000_000n);
    env.mintUsdc(fresh.publicKey, 2000n * USDC);
    expect(env.svm.getAccount(env.ata(fresh.publicKey, env.mint))).to.be.null;
    const { res } = await env.openAssetPosition({ ...buy(), user: fresh });
    expectOk(res);
    expect(env.tokenBalance(env.mint, fresh.publicKey)).to.equal(0n);
  });

  it("uses the asset's expiry time of day, not SOL's 08:00", async () => {
    const { res } = await env.openAssetPosition({
      ...sell(),
      expiryTs: alignedExpiry(7),
    });
    expectErr(res, "ExpiryNotAligned");
  });

  it("rejects user == market maker and a zero yield", async () => {
    expectErr(
      (await env.openAssetPosition({ ...sell(), user: env.mm })).res,
      "SameCounterparty"
    );
    expectErr(
      (await env.openAssetPosition({ ...sell(), yieldAmount: 0n })).res,
      "InvalidYield"
    );
  });

  it("fails when the MM cannot deliver the token", async () => {
    const { res } = await env.openAssetPosition({
      ...buy(),
      amount: 2_000_000n * USDC, // 11,111 tokens; the MM holds 10,000
    });
    expectErr(res, "insufficient funds");
  });
});

describe("asset settlement prices", () => {
  let env: AssetEnv;
  beforeEach(async () => {
    env = new AssetEnv();
    await env.bootstrapAsset();
  });

  it("poster posts once per asset and expiry, aligned to the asset", async () => {
    expectOk(await env.postAssetPrice(EXPIRY, 190n * USDC));
    const sp = await env.fetchAssetPrice(EXPIRY);
    expect(sp.assetMint.equals(env.mint)).to.be.true;
    expect(BigInt(sp.price.toString())).to.equal(190n * USDC);
    expect(sp.source).to.deep.equal({ poster: {} });
    expectErr(await env.postAssetPrice(EXPIRY, 191n * USDC), "already in use");
    expectErr(
      await env.postAssetPrice(alignedExpiry(7), 190n * USDC),
      "ExpiryNotAligned"
    );
    expectErr(
      await env.postAssetPrice(EXPIRY + 86_400, 190n * USDC, env.outsider),
      "UnauthorizedPricePoster"
    );
  });

  it("governance overrides with 3 signers", async () => {
    expectOk(await env.postAssetPrice(EXPIRY, 190n * USDC));
    expectErr(
      await env.overrideAssetPrice(EXPIRY, 170n * USDC, env.governance.slice(0, 2)),
      "InsufficientGovernanceSignatures"
    );
    expectOk(
      await env.overrideAssetPrice(EXPIRY, 170n * USDC, env.governance.slice(1, 4))
    );
    const sp = await env.fetchAssetPrice(EXPIRY);
    expect(BigInt(sp.price.toString())).to.equal(170n * USDC);
    expect(sp.source).to.deep.equal({ governance: {} });
    expect(sp.approvals).to.deep.equal([false, true, true, true, false]);
  });
});

describe("settle_asset_position", () => {
  let env: AssetEnv;
  beforeEach(async () => {
    env = new AssetEnv();
    await env.bootstrapAsset();
  });

  async function open(product: typeof SELL_SOL): Promise<PublicKey> {
    const sell = "sellSol" in product;
    const { res, position } = await env.openAssetPosition({
      product,
      fixedPrice: FIXED,
      expiryTs: EXPIRY,
      amount: sell ? SELL_AMOUNT : BUY_AMOUNT,
      yieldAmount: sell ? SELL_YIELD : BUY_YIELD,
      nonce: nextNonce(),
    });
    expectOk(res);
    return position;
  }

  async function postAndWait(price: bigint) {
    env.setTime(EXPIRY);
    expectOk(await env.postAssetPrice(EXPIRY, price));
    env.setTime(EXPIRY + DISPUTE_WINDOW);
  }

  const balances = () => ({
    userTok: env.tokenBalance(env.mint, env.user.publicKey),
    userUsdc: env.usdcBalance(env.user.publicKey),
    mmTok: env.tokenBalance(env.mint, env.mm.publicKey),
    mmUsdc: env.usdcBalance(env.mm.publicKey),
  });

  it("sell, price at or above fixed: the user is paid USDC, the MM gets the tokens", async () => {
    const position = await open(SELL_SOL);
    await postAndWait(FIXED);
    const before = balances();
    const mmSol = env.sol(env.mm.publicKey);
    expectOk(await env.settleAsset(position));
    const after = balances();
    expect(after.userUsdc - before.userUsdc).to.equal(1800n * USDC);
    expect(after.mmTok - before.mmTok).to.equal(SELL_AMOUNT);
    expect(after.userTok).to.equal(before.userTok);
    // Both vaults closed, their rent back to the MM.
    expect(env.svm.getAccount(env.ata(position, env.mint))).to.be.null;
    expect(env.svm.getAccount(env.ata(position, env.usdcMint.publicKey))).to.be
      .null;
    expect(env.sol(env.mm.publicKey) > mmSol).to.be.true;
    expect((await env.fetchAssetPosition(position)).settled).to.be.true;
  });

  it("sell, price below fixed: everyone keeps their own leg", async () => {
    const position = await open(SELL_SOL);
    await postAndWait(FIXED - 1n);
    const before = balances();
    expectOk(await env.settleAsset(position));
    const after = balances();
    expect(after.userTok - before.userTok).to.equal(SELL_AMOUNT);
    expect(after.mmUsdc - before.mmUsdc).to.equal(1800n * USDC);
  });

  it("buy, price at or below fixed: the user receives the tokens", async () => {
    const position = await open(BUY_SOL);
    await postAndWait(FIXED);
    const before = balances();
    expectOk(await env.settleAsset(position));
    const after = balances();
    expect(after.userTok - before.userTok).to.equal(10n * ASSET);
    expect(after.mmUsdc - before.mmUsdc).to.equal(BUY_AMOUNT);
  });

  it("buy, price above fixed: the user gets the USDC back", async () => {
    const position = await open(BUY_SOL);
    await postAndWait(FIXED + 1n);
    const before = balances();
    expectOk(await env.settleAsset(position));
    const after = balances();
    expect(after.userUsdc - before.userUsdc).to.equal(BUY_AMOUNT);
    expect(after.mmTok - before.mmTok).to.equal(10n * ASSET);
  });

  it("guards: before expiry, missing price, dispute window, twice", async () => {
    const position = await open(SELL_SOL);
    expectErr(await env.settleAsset(position), "NotExpiredYet");
    env.setTime(EXPIRY);
    expectErr(await env.settleAsset(position), "SettlementPriceMissing");
    expectOk(await env.postAssetPrice(EXPIRY, FIXED));
    expectErr(await env.settleAsset(position), "DisputeWindowOpen");
    env.setTime(EXPIRY + DISPUTE_WINDOW);
    expectOk(await env.settleAsset(position));
    expectErr(await env.settleAsset(position), "AlreadySettled");
  });

  it("a governance price settles at once, with no dispute window", async () => {
    const position = await open(BUY_SOL);
    env.setTime(EXPIRY);
    expectOk(
      await env.overrideAssetPrice(EXPIRY, FIXED, env.governance.slice(0, 3))
    );
    expectOk(await env.settleAsset(position));
  });

  it("stray tokens sent to a vault go to the MM", async () => {
    const position = await open(SELL_SOL);
    env.mintTokens(env.mint, position, 5n);
    await postAndWait(FIXED - 1n);
    const before = balances();
    expectOk(await env.settleAsset(position));
    const after = balances();
    expect(after.userTok - before.userTok).to.equal(SELL_AMOUNT);
    expect(after.mmTok - before.mmTok).to.equal(5n);
  });

  it("emergency cancel returns both legs with 3 governance signers", async () => {
    const position = await open(BUY_SOL);
    expectErr(
      await env.emergencyCancelAsset(position, env.governance.slice(0, 2)),
      "InsufficientGovernanceSignatures"
    );
    const before = balances();
    expectOk(await env.emergencyCancelAsset(position, env.governance.slice(0, 3)));
    const after = balances();
    expect(after.userUsdc - before.userUsdc).to.equal(BUY_AMOUNT);
    expect(after.mmTok - before.mmTok).to.equal(10n * ASSET);
    expect((await env.fetchAssetPosition(position)).settled).to.be.true;
  });
});
