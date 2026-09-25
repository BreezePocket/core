/**
 * Posts a settlement price for an expiry, signed by the price poster key.
 * Until the aggregator settlement job exists this is the manual equivalent:
 * take the Deribit SOL delivery price for the expiry and post it.
 *
 *   WALLET=keys/price-poster.json npm run post-price -- --expiry <unix_ts> --price 212.35
 *
 * `--price` is in USDC per SOL. `--expiry` must be 08:00 UTC.
 */
import { BN } from "@coral-xyz/anchor";
import { SystemProgram } from "@solana/web3.js";
import {
  args,
  configPda,
  connect,
  isAligned,
  required,
  settlementPricePda,
  usdcToBase,
} from "./common";

async function main() {
  const a = args();
  const expiry = Number(required(a, "expiry"));
  if (!isAligned(expiry)) throw new Error(`expiry ${expiry} is not 08:00 UTC`);
  const price = usdcToBase(required(a, "price"));
  const { program, wallet } = connect();

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
    `posted ${a.price} USDC/SOL for expiry ${expiry} (${new Date(
      expiry * 1000
    ).toISOString()}) -> ${settlementPricePda(expiry).toBase58()} (${sig})`
  );
  console.log(
    "settle is allowed 30 minutes after this transaction's block time"
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
