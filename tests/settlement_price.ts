import { expect } from "chai";
import { Env, USDC, alignedExpiry, expectErr, expectOk } from "./helpers";

const EXPIRY = alignedExpiry(7);

describe("post_settlement_price", () => {
  let env: Env;
  beforeEach(async () => {
    env = new Env();
    await env.bootstrap();
  });

  it("poster creates the SettlementPrice PDA with source = Poster", async () => {
    expectOk(await env.postPrice(EXPIRY, 260n * USDC));
    const sp = await env.fetchSettlementPrice(env.settlementPricePda(EXPIRY));
    expect(sp.token).to.deep.equal({ sol: {} });
    expect(sp.expiryTs.toNumber()).to.equal(EXPIRY);
    expect(BigInt(sp.price.toString())).to.equal(260n * USDC);
    expect(sp.postedTs.toNumber()).to.equal(env.now());
    expect(sp.source).to.deep.equal({ poster: {} });
    expect(sp.approvals).to.deep.equal([false, false, false, false, false]);
  });

  it("rejects any key other than the price poster", async () => {
    expectErr(
      await env.postPrice(EXPIRY, 260n * USDC, env.outsider),
      "UnauthorizedPricePoster"
    );
    expectErr(
      await env.postPrice(EXPIRY, 260n * USDC, env.governance[0]),
      "UnauthorizedPricePoster"
    );
  });

  it("rejects a second post for the same token and expiry", async () => {
    expectOk(await env.postPrice(EXPIRY, 260n * USDC));
    expectErr(await env.postPrice(EXPIRY, 270n * USDC), "already in use");
  });

  it("rejects an unaligned expiry and a zero price", async () => {
    expectErr(await env.postPrice(EXPIRY + 1, 260n * USDC), "ExpiryNotAligned");
    expectErr(await env.postPrice(EXPIRY, 0n), "InvalidFixedPrice");
  });
});

describe("override_settlement_price", () => {
  let env: Env;
  beforeEach(async () => {
    env = new Env();
    await env.bootstrap();
  });

  it("3 of 5 governance keys create the price when the poster never posted", async () => {
    const signers = env.governance.slice(0, 3);
    expectOk(await env.overridePrice(EXPIRY, 240n * USDC, signers));
    const sp = await env.fetchSettlementPrice(env.settlementPricePda(EXPIRY));
    expect(BigInt(sp.price.toString())).to.equal(240n * USDC);
    expect(sp.source).to.deep.equal({ governance: {} });
    expect(sp.approvals).to.deep.equal([true, true, true, false, false]);
    expect(sp.postedTs.toNumber()).to.equal(env.now());
  });

  it("replaces an existing poster price", async () => {
    expectOk(await env.postPrice(EXPIRY, 260n * USDC));
    const signers = [env.governance[1], env.governance[3], env.governance[4]];
    env.setTime(env.now() + 60);
    expectOk(await env.overridePrice(EXPIRY, 255n * USDC, signers));
    const sp = await env.fetchSettlementPrice(env.settlementPricePda(EXPIRY));
    expect(BigInt(sp.price.toString())).to.equal(255n * USDC);
    expect(sp.source).to.deep.equal({ governance: {} });
    expect(sp.approvals).to.deep.equal([false, true, false, true, true]);
  });

  it("fails with 2 of 5 signers", async () => {
    expectErr(
      await env.overridePrice(EXPIRY, 240n * USDC, env.governance.slice(0, 2)),
      "InsufficientGovernanceSignatures"
    );
  });

  it("counts a duplicated governance signer once", async () => {
    const signers = [env.governance[0], env.governance[0], env.governance[1]];
    expectErr(
      await env.overridePrice(EXPIRY, 240n * USDC, signers),
      "InsufficientGovernanceSignatures"
    );
  });

  it("fails if a non-governance key is among the signers", async () => {
    const signers = [env.governance[0], env.governance[1], env.outsider];
    expectErr(
      await env.overridePrice(EXPIRY, 240n * USDC, signers),
      "UnauthorizedGovernanceSigner"
    );
  });

  it("rejects an unaligned expiry", async () => {
    expectErr(
      await env.overridePrice(
        EXPIRY + 3600,
        240n * USDC,
        env.governance.slice(0, 3)
      ),
      "ExpiryNotAligned"
    );
  });
});
