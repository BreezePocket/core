/**
 * Permissionless settlement. Settles one position, or every unsettled position at
 * an expiry, using the posted settlement price.
 *
 *   npm run settle -- --position <pubkey>
 *   npm run settle -- --expiry <unix_ts>
 *
 * The WALLET pays the fee and rent for any missing USDC accounts.
 */
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { args, configPda, connect, settlementPricePda } from "./common";

async function main() {
  const a = args();
  const { program, wallet } = connect();
  const config = await program.account.globalConfig.fetch(configPda());

  let targets: { publicKey: PublicKey; account: any }[];
  if (a.position) {
    const pk = new PublicKey(a.position);
    targets = [
      {
        publicKey: pk,
        account: await program.account.positionAccount.fetch(pk),
      },
    ];
  } else if (a.expiry) {
    const all = await program.account.positionAccount.all();
    targets = all.filter(
      (p) =>
        p.account.expiryTs.toNumber() === Number(a.expiry) && !p.account.settled
    );
    console.log(
      `${targets.length} unsettled position(s) at expiry ${a.expiry}`
    );
  } else {
    throw new Error("pass --position <pubkey> or --expiry <unix_ts>");
  }

  let ok = 0;
  for (const { publicKey, account } of targets) {
    try {
      const sig = await program.methods
        .settle()
        .accountsStrict({
          caller: wallet.publicKey,
          config: configPda(),
          position: publicKey,
          settlementPrice: settlementPricePda(account.expiryTs.toNumber()),
          user: account.user,
          marketMaker: account.marketMaker,
          usdcMint: config.usdcMint,
          positionUsdcVault: getAssociatedTokenAddressSync(
            config.usdcMint,
            publicKey,
            true
          ),
          userUsdcAta: getAssociatedTokenAddressSync(
            config.usdcMint,
            account.user,
            true
          ),
          mmUsdcAta: getAssociatedTokenAddressSync(
            config.usdcMint,
            account.marketMaker,
            true
          ),
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      ok++;
      console.log(`settled ${publicKey.toBase58()} (${sig})`);
    } catch (e: any) {
      console.error(`failed ${publicKey.toBase58()}: ${e.message ?? e}`);
    }
  }
  console.log(`${ok}/${targets.length} settled`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
