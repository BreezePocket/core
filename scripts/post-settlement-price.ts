/**
 * Posts a settlement price for an expiry, signed by the price poster key.
 * Until the aggregator settlement job exists this is the manual equivalent:
 * take the delivery price for the expiry and post it.
 *
 *   WALLET=keys/price-poster.json npm run post-price -- --expiry <unix_ts> --price 212.35
 *   WALLET=keys/price-poster.json npm run post-price -- --asset NVDAon --expiry <unix_ts> --price 181.2
 *
 * `--price` is in USDC per token. Without `--asset` it is SOL's Deribit delivery
 * price and `--expiry` must be 08:00 UTC; a listed asset's expiry must land on
 * that asset's own time of day.
 */
import { BN } from "@coral-xyz/anchor";
import { SystemProgram } from "@solana/web3.js";
import {
  DAY,
  args,
  assetPda,
  assetPricePda,
  configPda,
  connect,
  findAsset,
  isAligned,
  required,
  settlementPricePda,
  usdcToBase,
} from "./common";

async function main() {
  const a = args();
  const expiry = Number(required(a, "expiry"));
  const price = usdcToBase(required(a, "price"));
  const { program, wallet } = connect();
  const when = new Date(expiry * 1000).toISOString();

  if (a.asset) {
    const asset = await findAsset(program, a.asset);
    if (expiry % DAY !== asset.expiryTimeOfDay) {
      throw new Error(`expiry ${expiry} is not at ${asset.symbol}'s expiry time`);
    }
    const account = assetPricePda(asset.mint, expiry);
    const sig = await program.methods
      .postAssetSettlementPrice(new BN(expiry), new BN(price.toString()))
      .accountsStrict({
        poster: wallet.publicKey,
        config: configPda(),
        asset: assetPda(asset.mint),
        settlementPrice: account,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log(
      `posted ${a.price} USDC/${asset.symbol} for expiry ${expiry} (${when}) -> ${account.toBase58()} (${sig})`
    );
  } else {
    if (!isAligned(expiry)) throw new Error(`expiry ${expiry} is not 08:00 UTC`);
    const sig = await program.methods
      .postSettlementPrice(
        { sol: {} } as any,
        new BN(expiry),
        new BN(price.toString())
      )
      .accountsStrict({
        poster: wallet.publicKey,
        config: configPda(),
        settlementPrice: settlementPricePda(expiry),
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log(
      `posted ${a.price} USDC/SOL for expiry ${expiry} (${when}) -> ${settlementPricePda(
        expiry
      ).toBase58()} (${sig})`
    );
  }
  console.log(
    "settle is allowed 30 minutes after this transaction's block time"
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
