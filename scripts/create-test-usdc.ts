/**
 * Creates a 6-decimal test USDC mint on the configured cluster (testnet has no
 * canonical USDC) and optionally mints an initial supply to one or more wallets.
 *
 *   SOLANA_RPC=https://api.testnet.solana.com \
 *   npm run create-test-usdc -- --mint-to <pubkey>[,<pubkey>] --amount 100000
 *
 * The wallet in WALLET becomes the mint authority. Save the printed mint address;
 * `initialize-config` needs it and the MM reads it from USDC_MINT.
 */
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
import { args, connect, usdcToBase } from "./common";

async function main() {
  const a = args();
  const { connection, wallet } = connect();
  const mint = Keypair.generate();
  const rent = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);

  // --mint <existing> skips creation and only mints to the targets.
  const existing = a.mint ? new PublicKey(a.mint) : null;
  const mintPubkey = existing ?? mint.publicKey;
  if (!existing) {
    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: wallet.publicKey,
        newAccountPubkey: mint.publicKey,
        lamports: rent,
        space: MINT_SIZE,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMint2Instruction(
        mint.publicKey,
        6,
        wallet.publicKey,
        null
      )
    );
    const sig = await sendAndConfirmTransaction(connection, tx, [wallet, mint]);
    console.log(`test USDC mint: ${mint.publicKey.toBase58()}`);
    console.log(`  tx: ${sig}`);
  }

  if (a["mint-to"]) {
    const amount = usdcToBase(a.amount ?? "100000");
    for (const target of a["mint-to"].split(",")) {
      const owner = new PublicKey(target.trim());
      const ata = getAssociatedTokenAddressSync(mintPubkey, owner, true);
      const mintTx = new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(
          wallet.publicKey,
          ata,
          owner,
          mintPubkey
        ),
        createMintToInstruction(mintPubkey, ata, wallet.publicKey, amount)
      );
      const s = await sendAndConfirmTransaction(connection, mintTx, [wallet]);
      console.log(
        `  minted ${a.amount ?? "100000"} USDC to ${owner.toBase58()} (${s})`
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
