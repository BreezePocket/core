/**
 * One-time GlobalConfig initialization after `anchor deploy`.
 *
 *   npm run init-config -- \
 *     --usdc-mint <mint> \
 *     --poster <pubkey> \
 *     --governance <pk1>,<pk2>,<pk3>,<pk4>,<pk5>
 *
 * Pass `--generate-keys keys/` to create fresh governance + poster keypairs in that
 * directory (gitignored) instead of supplying public keys. WALLET pays the rent.
 */
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import fs from "fs";
import path from "path";
import { args, configPda, connect, required } from "./common";

async function main() {
  const a = args();
  const { program, wallet } = connect();

  let governance: PublicKey[];
  let poster: PublicKey;
  if (a["generate-keys"]) {
    const dir = a["generate-keys"];
    fs.mkdirSync(dir, { recursive: true });
    const write = (name: string) => {
      const kp = Keypair.generate();
      fs.writeFileSync(
        path.join(dir, `${name}.json`),
        JSON.stringify(Array.from(kp.secretKey))
      );
      return kp.publicKey;
    };
    governance = Array.from({ length: 5 }, (_, i) =>
      write(`governance-${i + 1}`)
    );
    poster = write("price-poster");
    console.log(
      `wrote governance-1..5.json and price-poster.json to ${dir} (keep these out of git)`
    );
  } else {
    governance = required(a, "governance")
      .split(",")
      .map((k) => new PublicKey(k.trim()));
    poster = new PublicKey(required(a, "poster"));
  }
  if (governance.length !== 5) {
    throw new Error("exactly 5 governance keys are required");
  }
  const usdcMint = new PublicKey(required(a, "usdc-mint"));

  const sig = await program.methods
    .initializeConfig({
      governanceKeys: governance as any,
      pricePoster: poster,
    })
    .accountsStrict({
      payer: wallet.publicKey,
      config: configPda(),
      usdcMint,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log(`GlobalConfig ${configPda().toBase58()} initialized (${sig})`);
  console.log(`  price poster: ${poster.toBase58()}`);
  console.log(`  usdc mint:    ${usdcMint.toBase58()}`);
  governance.forEach((g, i) =>
    console.log(`  governance ${i + 1}: ${g.toBase58()}`)
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
