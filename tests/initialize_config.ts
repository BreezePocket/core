import { expect } from "chai";
import { Env, expectErr, expectOk } from "./helpers";

describe("initialize_config", () => {
  it("creates the GlobalConfig PDA with governance keys, poster and USDC mint", async () => {
    const env = new Env();
    expectOk(await env.initializeConfig());
    const cfg = await env.fetchConfig();
    expect(cfg.requiredSignatures).to.equal(3);
    expect(cfg.pricePoster.equals(env.poster.publicKey)).to.be.true;
    expect(cfg.usdcMint.equals(env.usdcMint.publicKey)).to.be.true;
    cfg.governanceKeys.forEach(
      (k: any, i: number) =>
        expect(k.equals(env.governance[i].publicKey)).to.be.true
    );
  });

  it("cannot be called twice", async () => {
    const env = new Env();
    expectOk(await env.initializeConfig());
    expectErr(await env.initializeConfig(), "already in use");
  });

  it("rejects duplicate governance keys", async () => {
    const env = new Env();
    const keys = env.governance.map((k) => k.publicKey);
    keys[4] = keys[0];
    expectErr(await env.initializeConfig(keys), "DuplicateGovernanceKey");
  });
});
