/**
 * Shared helpers for the operational scripts. Everything is driven by env vars so
 * no key material or RPC URL is ever committed:
 *
 *   SOLANA_RPC     RPC endpoint (default: https://api.testnet.solana.com)
 *   SOLANA_SCAN_RPC  RPC for getProgramAccounts scans, which some free tiers
 *                  (e.g. Alchemy) block (default: SOLANA_RPC)
 *   WALLET         path to the signing keypair (default: ~/.config/solana/id.json)
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import fs from "fs";
import os from "os";
import path from "path";
import { Breezepocket } from "../target/types/breezepocket";

export const IDL = require("../target/idl/breezepocket.json");
export const PROGRAM_ID = new PublicKey(IDL.address);

export const DAY = 86_400;
export const USDC_DECIMALS = 6;

export function loadKeypair(file: string): Keypair {
  const resolved = file.startsWith("~")
    ? path.join(os.homedir(), file.slice(1))
    : file;
  const raw = JSON.parse(fs.readFileSync(resolved, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

export function rpcUrl(): string {
  return process.env.SOLANA_RPC ?? "https://api.testnet.solana.com";
}

export function walletPath(): string {
  return process.env.WALLET ?? "~/.config/solana/id.json";
}

export function connect(): {
  connection: Connection;
  wallet: Keypair;
  program: Program<Breezepocket>;
} {
  // Some HTTP-only RPCs (e.g. Alchemy free tier) lack signatureSubscribe, which
  // web3.js confirmation relies on; route subscriptions to SOLANA_WS instead.
  const connection = new Connection(rpcUrl(), {
    commitment: "confirmed",
    wsEndpoint: process.env.SOLANA_WS ?? "wss://api.devnet.solana.com/",
  });
  const wallet = loadKeypair(walletPath());
  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(wallet),
    {
      commitment: "confirmed",
    }
  );
  anchor.setProvider(provider);
  const program = new Program<Breezepocket>(IDL, provider);
  return { connection, wallet, program };
}

export function configPda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    PROGRAM_ID
  )[0];
}

export function settlementPricePda(expiryTs: number): PublicKey {
  const buf = Buffer.alloc(8);
  buf.writeBigInt64LE(BigInt(expiryTs));
  return PublicKey.findProgramAddressSync(
    [Buffer.from("settlement_price"), Buffer.from([0]), buf],
    PROGRAM_ID
  )[0];
}

/** Parse `--flag value` pairs from argv. */
export function args(): Record<string, string> {
  const out: Record<string, string> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      out[argv[i].slice(2)] = argv[i + 1] ?? "true";
      i++;
    }
  }
  return out;
}

export function required(a: Record<string, string>, key: string): string {
  const v = a[key] ?? process.env[key.toUpperCase().replace(/-/g, "_")];
  if (!v) {
    console.error(`missing --${key}`);
    process.exit(1);
  }
  return v;
}

/** Next 08:00 UTC expiry strictly after `from` plus `daysAhead` days. */
export function alignedExpiry(
  daysAhead: number,
  from = Math.floor(Date.now() / 1000)
): number {
  const day = Math.floor(from / DAY) * DAY;
  let ts = day + 8 * 3600;
  if (ts <= from) ts += DAY;
  return ts + daysAhead * DAY;
}

export function isAligned(expiryTs: number): boolean {
  return expiryTs % DAY === 8 * 3600;
}

export function usdcToBase(usdc: string | number): bigint {
  const [whole, frac = ""] = String(usdc).split(".");
  const fracPadded = (frac + "000000").slice(0, USDC_DECIMALS);
  return BigInt(whole) * 10n ** BigInt(USDC_DECIMALS) + BigInt(fracPadded);
}

export function assetPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("asset"), mint.toBuffer()],
    PROGRAM_ID
  )[0];
}

export function assetPricePda(mint: PublicKey, expiryTs: number): PublicKey {
  const buf = Buffer.alloc(8);
  buf.writeBigInt64LE(BigInt(expiryTs));
  return PublicKey.findProgramAddressSync(
    [Buffer.from("asset_price"), mint.toBuffer(), buf],
    PROGRAM_ID
  )[0];
}

export type ListedAsset = {
  address: PublicKey;
  mint: PublicKey;
  symbol: string;
  decimals: number;
  expiryTimeOfDay: number;
};

/** The program bound to SOLANA_SCAN_RPC, for account scans. */
export function scanProgram(program: Program<Breezepocket>): Program<Breezepocket> {
  const url = process.env.SOLANA_SCAN_RPC;
  if (!url) return program;
  const provider = new anchor.AnchorProvider(
    new Connection(url, "confirmed"),
    program.provider.wallet!,
    { commitment: "confirmed" }
  );
  return new Program<Breezepocket>(IDL, provider);
}

/** Every asset governance has listed, keyed by symbol. */
export async function listedAssets(
  program: Program<Breezepocket>
): Promise<Map<string, ListedAsset>> {
  const rows = await scanProgram(program).account.assetConfig.all();
  return new Map(
    rows.map((r) => [
      r.account.symbol,
      {
        address: r.publicKey,
        mint: r.account.mint,
        symbol: r.account.symbol,
        decimals: r.account.decimals,
        expiryTimeOfDay: r.account.expiryTimeOfDay.toNumber(),
      },
    ])
  );
}

/** A listed asset by symbol (case-insensitive) or mint address. */
export async function findAsset(
  program: Program<Breezepocket>,
  symbolOrMint: string
): Promise<ListedAsset> {
  const all = [...(await listedAssets(program)).values()];
  const hit = all.find(
    (a) =>
      a.symbol.toLowerCase() === symbolOrMint.toLowerCase() ||
      a.mint.toBase58() === symbolOrMint
  );
  if (!hit) throw new Error(`asset ${symbolOrMint} is not listed`);
  return hit;
}

/** Seconds after 00:00 UTC from "HH:MM". */
export function timeOfDay(hhmm: string): number {
  const [h, m = "0"] = hhmm.split(":");
  return Number(h) * 3600 + Number(m) * 60;
}
