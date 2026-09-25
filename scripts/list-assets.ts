/**
 * Lists SPL assets on the program (3/5 governance) and, on a test cluster, creates
 * a 9-decimal test mint for each and mints inventory to the market maker.
 *
 *   npm run list-assets -- --assets NVDAon@20:00,WBTC@08:00 --mint-to <mm pubkey> --amount 100000
 *
 * Each entry is SYMBOL@HH:MM, the UTC time every expiry of that asset lands on
 * (08:00 for Deribit and PreStocks, 20:00 for US equities). `SYMBOL=<mint>@HH:MM`
 * lists an existing mint instead of creating one. Already-listed symbols are
 * skipped, and inventory is only minted to a `--mint-to` wallet holding none of the
 * token, so a re-run after a partial failure is safe. WALLET pays and becomes the test mints' authority;
 * `--governance` names three governance keypairs (default keys/governance-1..3.json).
 */
import { BN } from "@coral-xyz/anchor";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  args,
  assetPda,
  configPda,
  connect,
  listedAssets,
  loadKeypair,
  required,
  timeOfDay,
} from "./common";

const DECIMALS = 9;

async function main() {
  const a = args();
  const { connection, wallet, program } = connect();
  const governance = (
    a.governance ??
    "keys/governance-1.json,keys/governance-2.json,keys/governance-3.json"
  )
    .split(",")
    .map((f) => loadKeypair(f.trim()));
  const mintTo = a["mint-to"] ? new PublicKey(a["mint-to"]) : null;
  const amount = BigInt(a.amount ?? "100000") * 10n ** BigInt(DECIMALS);

  const listed = await listedAssets(program);
  for (const entry of required(a, "assets").split(",")) {
    const [name, hhmm] = entry.trim().split("@");
    const [symbol, existingMint] = name.split("=");
    if (!hhmm) throw new Error(`${entry}: expected SYMBOL@HH:MM`);
    let mint: PublicKey;
    const known = listed.get(symbol);
    if (known) {
      mint = known.mint;
      console.log(`${symbol}: already listed, mint ${mint.toBase58()}`);
    } else {
      if (existingMint) {
        mint = new PublicKey(existingMint);
      } else {
        const kp = Keypair.generate();
        const rent = await connection.getMinimumBalanceForRentExemption(
          MINT_SIZE
        );
        await sendAndConfirmTransaction(
          connection,
          new Transaction().add(
            SystemProgram.createAccount({
              fromPubkey: wallet.publicKey,
              newAccountPubkey: kp.publicKey,
              lamports: rent,
              space: MINT_SIZE,
              programId: TOKEN_PROGRAM_ID,
            }),
            createInitializeMint2Instruction(
              kp.publicKey,
              DECIMALS,
              wallet.publicKey,
              null
            )
          ),
          [wallet, kp]
        );
        mint = kp.publicKey;
      }
      const sig = await program.methods
        .listAsset({
          symbol,
          expiryTimeOfDay: new BN(timeOfDay(hhmm)),
        })
        .accountsStrict({
          payer: wallet.publicKey,
          config: configPda(),
          assetMint: mint,
          asset: assetPda(mint),
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts(
          governance.map((k) => ({
            pubkey: k.publicKey,
            isSigner: true,
            isWritable: false,
          }))
        )
        .signers(governance)
        .rpc();
      console.log(`${symbol}: listed mint ${mint.toBase58()} at ${hhmm} UTC (${sig})`);
    }

    if (mintTo && !existingMint) {
      const ata = getAssociatedTokenAddressSync(mint, mintTo, true);
      const held = await connection
        .getTokenAccountBalance(ata)
        .then((b) => BigInt(b.value.amount))
        .catch(() => 0n);
      if (held > 0n) continue;
      await sendAndConfirmTransaction(
        connection,
        new Transaction().add(
          createAssociatedTokenAccountIdempotentInstruction(
            wallet.publicKey,
            ata,
            mintTo,
            mint
          ),
          createMintToInstruction(mint, ata, wallet.publicKey, amount)
        ),
        [wallet]
      );
      console.log(`  minted ${a.amount ?? "100000"} ${symbol} to ${mintTo.toBase58()}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
