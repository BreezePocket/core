/**
 * Permissionless settlement. Settles one position, or every unsettled position at
 * an expiry (SOL and listed assets alike), using the posted settlement price.
 *
 *   npm run settle -- --position <pubkey>
 *   npm run settle -- --expiry <unix_ts>
 *
 * The WALLET pays the fee and rent for any missing token accounts.
 */
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  args,
  assetPricePda,
  configPda,
  connect,
  scanProgram,
  settlementPricePda,
} from "./common";

type Target = { publicKey: PublicKey; account: any; asset: boolean };

async function main() {
  const a = args();
  const { program, wallet } = connect();
  const config = await program.account.globalConfig.fetch(configPda());
  const ata = (mint: PublicKey, owner: PublicKey) =>
    getAssociatedTokenAddressSync(mint, owner, true);

  let targets: Target[];
  if (a.position) {
    const pk = new PublicKey(a.position);
    const sol = await program.account.positionAccount.fetchNullable(pk);
    targets = sol
      ? [{ publicKey: pk, account: sol, asset: false }]
      : [
          {
            publicKey: pk,
            account: await program.account.assetPosition.fetch(pk),
            asset: true,
          },
        ];
  } else if (a.expiry) {
    const at = (p: { account: any }) =>
      p.account.expiryTs.toNumber() === Number(a.expiry) && !p.account.settled;
    targets = [
      ...(await scanProgram(program).account.positionAccount.all())
        .filter(at)
        .map((p) => ({ ...p, asset: false })),
      ...(await scanProgram(program).account.assetPosition.all())
        .filter(at)
        .map((p) => ({ ...p, asset: true })),
    ];
    console.log(
      `${targets.length} unsettled position(s) at expiry ${a.expiry}`
    );
  } else {
    throw new Error("pass --position <pubkey> or --expiry <unix_ts>");
  }

  let ok = 0;
  for (const { publicKey, account, asset } of targets) {
    try {
      const common = {
        config: configPda(),
        position: publicKey,
        user: account.user,
        marketMaker: account.marketMaker,
        usdcMint: config.usdcMint,
        positionUsdcVault: ata(config.usdcMint, publicKey),
        userUsdcAta: ata(config.usdcMint, account.user),
        mmUsdcAta: ata(config.usdcMint, account.marketMaker),
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      };
      const expiry = account.expiryTs.toNumber();
      const sig = asset
        ? await program.methods
            .settleAssetPosition()
            .accountsStrict({
              ...common,
              caller: wallet.publicKey,
              settlementPrice: assetPricePda(account.assetMint, expiry),
              assetMint: account.assetMint,
              positionAssetVault: ata(account.assetMint, publicKey),
              userAssetAta: ata(account.assetMint, account.user),
              mmAssetAta: ata(account.assetMint, account.marketMaker),
            })
            .rpc()
        : await program.methods
            .settle()
            .accountsStrict({
              ...common,
              caller: wallet.publicKey,
              settlementPrice: settlementPricePda(expiry),
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
