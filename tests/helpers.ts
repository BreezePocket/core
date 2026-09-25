import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  ACCOUNT_SIZE,
  AccountLayout,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  FailedTransactionMetadata,
  LiteSVM,
  TransactionMetadata,
} from "litesvm";
import { expect } from "chai";
import path from "path";
import { Breezepocket } from "../target/types/breezepocket";

const IDL = require("../target/idl/breezepocket.json");
export const PROGRAM_ID = new PublicKey(IDL.address);

export const LAMPORTS_PER_SOL = 1_000_000_000n;
export const USDC = 1_000_000n; // 6 decimals
export const DAY = 86_400;
export const DISPUTE_WINDOW = 30 * 60;

/** Fixed "now" for every test: 2027-01-15 12:00:00 UTC. */
export const NOW = 1_800_014_400;

export type Product = { sellSol: {} } | { buySol: {} };
export const SELL_SOL: Product = { sellSol: {} };
export const BUY_SOL: Product = { buySol: {} };
export const TOKEN_SOL = { sol: {} };
/** Every listed asset in the tests: 9 decimals like the devnet test mints. */
export const ASSET = 1_000_000_000n;
export const US_CLOSE = 20 * 3600;

export function alignedExpiry(daysAhead: number, from = NOW): number {
  const day = Math.floor(from / DAY) * DAY;
  return day + daysAhead * DAY + 8 * 3600;
}

export class Env {
  svm: LiteSVM;
  program: Program<Breezepocket>;
  mm: Keypair;
  user: Keypair;
  poster: Keypair;
  governance: Keypair[];
  outsider: Keypair;
  usdcMint: Keypair;
  config: PublicKey;

  constructor() {
    this.svm = new LiteSVM();
    this.svm.addProgramFromFile(
      PROGRAM_ID,
      path.join(__dirname, "../target/deploy/breezepocket.so")
    );
    this.setTime(NOW);

    const provider = new anchor.AnchorProvider(
      new Connection("http://127.0.0.1:8899"),
      new anchor.Wallet(Keypair.generate()),
      {}
    );
    this.program = new Program<Breezepocket>(IDL, provider);

    this.mm = Keypair.generate();
    this.user = Keypair.generate();
    this.poster = Keypair.generate();
    this.outsider = Keypair.generate();
    this.governance = Array.from({ length: 5 }, () => Keypair.generate());
    this.usdcMint = Keypair.generate();
    [this.config] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      PROGRAM_ID
    );

    for (const k of [
      this.mm,
      this.user,
      this.poster,
      this.outsider,
      ...this.governance,
    ]) {
      this.svm.airdrop(k.publicKey, 1_000n * LAMPORTS_PER_SOL);
    }
    this.createUsdcMint();
  }

  setTime(unixTs: number) {
    const clock = this.svm.getClock();
    clock.unixTimestamp = BigInt(unixTs);
    this.svm.setClock(clock);
  }

  now(): number {
    return Number(this.svm.getClock().unixTimestamp);
  }

  send(
    ixs: TransactionInstruction[],
    signers: Keypair[],
    feePayer: PublicKey = signers[0].publicKey
  ): TransactionMetadata | FailedTransactionMetadata {
    const tx = new Transaction();
    tx.recentBlockhash = this.svm.latestBlockhash();
    tx.feePayer = feePayer;
    tx.add(...ixs);
    tx.sign(...signers);
    const res = this.svm.sendTransaction(tx);
    this.svm.expireBlockhash();
    return res;
  }

  /** Send an already-built transaction (used for partial-signature tests). */
  sendRaw(tx: Transaction): TransactionMetadata | FailedTransactionMetadata {
    const res = this.svm.sendTransaction(tx);
    this.svm.expireBlockhash();
    return res;
  }

  createUsdcMint() {
    this.createMint(this.usdcMint, 6);
  }

  /** A mint with the MM as authority. */
  createMint(mint: Keypair, decimals: number) {
    const rent = this.svm.minimumBalanceForRentExemption(BigInt(MINT_SIZE));
    const ixs = [
      SystemProgram.createAccount({
        fromPubkey: this.mm.publicKey,
        newAccountPubkey: mint.publicKey,
        lamports: Number(rent),
        space: MINT_SIZE,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMint2Instruction(
        mint.publicKey,
        decimals,
        this.mm.publicKey,
        null
      ),
    ];
    expectOk(this.send(ixs, [this.mm, mint]));
  }

  /** Create the owner's ATA for `mint` (if missing) and mint `amount` to it. */
  mintTokens(mint: PublicKey, owner: PublicKey, amount: bigint) {
    const ata = this.ata(owner, mint);
    const ixs: TransactionInstruction[] = [];
    if (!this.svm.getAccount(ata)) {
      ixs.push(
        createAssociatedTokenAccountInstruction(
          this.mm.publicKey,
          ata,
          owner,
          mint
        )
      );
    }
    ixs.push(createMintToInstruction(mint, ata, this.mm.publicKey, amount));
    expectOk(this.send(ixs, [this.mm]));
  }

  tokenBalance(mint: PublicKey, owner: PublicKey): bigint {
    return this.tokenAccountBalance(this.ata(owner, mint)) ?? 0n;
  }

  ata(owner: PublicKey, mint: PublicKey = this.usdcMint.publicKey): PublicKey {
    return getAssociatedTokenAddressSync(mint, owner, true);
  }

  /** Create the owner's USDC ATA (if missing) and mint `amount` base units to it. */
  mintUsdc(owner: PublicKey, amount: bigint) {
    const ata = this.ata(owner);
    const ixs: TransactionInstruction[] = [];
    if (!this.svm.getAccount(ata)) {
      ixs.push(
        createAssociatedTokenAccountInstruction(
          this.mm.publicKey,
          ata,
          owner,
          this.usdcMint.publicKey
        )
      );
    }
    ixs.push(
      createMintToInstruction(
        this.usdcMint.publicKey,
        ata,
        this.mm.publicKey,
        amount
      )
    );
    expectOk(this.send(ixs, [this.mm]));
  }

  usdcBalance(owner: PublicKey): bigint {
    return this.tokenAccountBalance(this.ata(owner)) ?? 0n;
  }

  tokenAccountBalance(address: PublicKey): bigint | null {
    const acc = this.svm.getAccount(address);
    if (!acc || acc.data.length < ACCOUNT_SIZE) return null;
    return AccountLayout.decode(acc.data).amount;
  }

  sol(owner: PublicKey): bigint {
    return this.svm.getBalance(owner) ?? 0n;
  }

  async initializeConfig(
    governance: PublicKey[] = this.governance.map((k) => k.publicKey),
    poster: PublicKey = this.poster.publicKey
  ) {
    const ix = await this.program.methods
      .initializeConfig({
        governanceKeys: governance as any,
        pricePoster: poster,
      })
      .accountsStrict({
        payer: this.mm.publicKey,
        config: this.config,
        usdcMint: this.usdcMint.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    return this.send([ix], [this.mm]);
  }

  /** Full setup used by most suites: config + USDC balances for both parties. */
  async bootstrap() {
    expectOk(await this.initializeConfig());
    this.mintUsdc(this.mm.publicKey, 1_000_000n * USDC);
    this.mintUsdc(this.user.publicKey, 100_000n * USDC);
  }

  positionPda(
    user: PublicKey,
    mm: PublicKey,
    fixedPrice: bigint,
    expiryTs: number,
    nonce: bigint
  ): PublicKey {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("position"),
        user.toBuffer(),
        mm.toBuffer(),
        u64le(fixedPrice),
        i64le(BigInt(expiryTs)),
        u64le(nonce),
      ],
      PROGRAM_ID
    )[0];
  }

  settlementPricePda(expiryTs: number, tokenByte = 0): PublicKey {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("settlement_price"),
        Buffer.from([tokenByte]),
        i64le(BigInt(expiryTs)),
      ],
      PROGRAM_ID
    )[0];
  }

  vault(position: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(
      this.usdcMint.publicKey,
      position,
      true
    );
  }

  async openPositionIx(
    p: OpenArgs
  ): Promise<{ ix: TransactionInstruction; position: PublicKey }> {
    const user = p.user ?? this.user;
    const mm = p.mm ?? this.mm;
    const mint = p.usdcMint ?? this.usdcMint.publicKey;
    const position = this.positionPda(
      user.publicKey,
      mm.publicKey,
      p.fixedPrice,
      p.expiryTs,
      p.nonce
    );
    const ix = await this.program.methods
      .openPosition({
        product: p.product as any,
        fixedPrice: new BN(p.fixedPrice.toString()),
        expiryTs: new BN(p.expiryTs),
        amount: new BN(p.amount.toString()),
        yieldAmount: new BN(p.yieldAmount.toString()),
        nonce: new BN(p.nonce.toString()),
      })
      .accountsStrict({
        marketMaker: mm.publicKey,
        user: user.publicKey,
        config: this.config,
        position,
        usdcMint: mint,
        positionUsdcVault: getAssociatedTokenAddressSync(mint, position, true),
        userUsdcAta: this.ata(user.publicKey, mint),
        mmUsdcAta: this.ata(mm.publicKey, mint),
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    return { ix, position };
  }

  async openPosition(p: OpenArgs) {
    const user = p.user ?? this.user;
    const mm = p.mm ?? this.mm;
    const { ix, position } = await this.openPositionIx(p);
    const res = this.send([ix], [mm, user], mm.publicKey);
    return { res, position };
  }

  async fetchPosition(position: PublicKey) {
    const acc = this.svm.getAccount(position);
    if (!acc) throw new Error("position account missing");
    return this.program.coder.accounts.decode(
      "positionAccount",
      Buffer.from(acc.data)
    );
  }

  async fetchSettlementPrice(address: PublicKey) {
    const acc = this.svm.getAccount(address);
    if (!acc) throw new Error("settlement price account missing");
    return this.program.coder.accounts.decode(
      "settlementPrice",
      Buffer.from(acc.data)
    );
  }

  async fetchConfig() {
    const acc = this.svm.getAccount(this.config);
    if (!acc) throw new Error("config missing");
    return this.program.coder.accounts.decode(
      "globalConfig",
      Buffer.from(acc.data)
    );
  }

  async postPrice(
    expiryTs: number,
    price: bigint,
    poster: Keypair = this.poster
  ) {
    const ix = await this.program.methods
      .postSettlementPrice(
        TOKEN_SOL as any,
        new BN(expiryTs),
        new BN(price.toString())
      )
      .accountsStrict({
        poster: poster.publicKey,
        config: this.config,
        settlementPrice: this.settlementPricePda(expiryTs),
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    return this.send([ix], [poster]);
  }

  async overridePrice(
    expiryTs: number,
    price: bigint,
    signers: Keypair[],
    payer: Keypair = this.outsider
  ) {
    const ix = await this.program.methods
      .overrideSettlementPrice(
        TOKEN_SOL as any,
        new BN(expiryTs),
        new BN(price.toString())
      )
      .accountsStrict({
        payer: payer.publicKey,
        config: this.config,
        settlementPrice: this.settlementPricePda(expiryTs),
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(
        signers.map((s) => ({
          pubkey: s.publicKey,
          isSigner: true,
          isWritable: false,
        }))
      )
      .instruction();
    return this.send([ix], [payer, ...signers]);
  }

  async settle(
    position: PublicKey,
    caller: Keypair = this.outsider,
    opts: { settlementPrice?: PublicKey } = {}
  ) {
    const pos = await this.fetchPosition(position);
    const ix = await this.program.methods
      .settle()
      .accountsStrict({
        caller: caller.publicKey,
        config: this.config,
        position,
        settlementPrice:
          opts.settlementPrice ??
          this.settlementPricePda(pos.expiryTs.toNumber()),
        user: pos.user,
        marketMaker: pos.marketMaker,
        usdcMint: this.usdcMint.publicKey,
        positionUsdcVault: this.vault(position),
        userUsdcAta: this.ata(pos.user),
        mmUsdcAta: this.ata(pos.marketMaker),
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    return this.send([ix], [caller]);
  }

  async emergencyCancel(
    position: PublicKey,
    signers: Keypair[],
    payer: Keypair = this.outsider
  ) {
    const pos = await this.fetchPosition(position);
    const ix = await this.program.methods
      .emergencyCancel()
      .accountsStrict({
        payer: payer.publicKey,
        config: this.config,
        position,
        user: pos.user,
        marketMaker: pos.marketMaker,
        usdcMint: this.usdcMint.publicKey,
        positionUsdcVault: this.vault(position),
        userUsdcAta: this.ata(pos.user),
        mmUsdcAta: this.ata(pos.marketMaker),
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(
        signers.map((s) => ({
          pubkey: s.publicKey,
          isSigner: true,
          isWritable: false,
        }))
      )
      .instruction();
    return this.send([ix], [payer, ...signers]);
  }
}

/** Listed-asset helpers, on top of a bootstrapped Env. */
export class AssetEnv extends Env {
  assetMint = Keypair.generate();

  get mint(): PublicKey {
    return this.assetMint.publicKey;
  }

  /** Config, USDC and a 9-decimal asset listed at 20:00 UTC, funded on both sides. */
  async bootstrapAsset(timeOfDay = US_CLOSE) {
    await this.bootstrap();
    this.createMint(this.assetMint, 9);
    expectOk(
      await this.listAsset(this.mint, "NVDAon", timeOfDay, this.governance.slice(0, 3))
    );
    this.mintTokens(this.mint, this.mm.publicKey, 10_000n * ASSET);
    this.mintTokens(this.mint, this.user.publicKey, 1_000n * ASSET);
  }

  assetPda(mint: PublicKey = this.mint): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("asset"), mint.toBuffer()],
      PROGRAM_ID
    )[0];
  }

  async listAsset(
    mint: PublicKey,
    symbol: string,
    expiryTimeOfDay: number,
    signers: Keypair[],
    payer: Keypair = this.outsider
  ) {
    const ix = await this.program.methods
      .listAsset({ symbol, expiryTimeOfDay: new BN(expiryTimeOfDay) })
      .accountsStrict({
        payer: payer.publicKey,
        config: this.config,
        assetMint: mint,
        asset: this.assetPda(mint),
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(
        signers.map((s) => ({
          pubkey: s.publicKey,
          isSigner: true,
          isWritable: false,
        }))
      )
      .instruction();
    return this.send([ix], [payer, ...signers]);
  }

  assetPositionPda(
    user: PublicKey,
    mm: PublicKey,
    fixedPrice: bigint,
    expiryTs: number,
    nonce: bigint,
    mint: PublicKey = this.mint
  ): PublicKey {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("asset_position"),
        user.toBuffer(),
        mm.toBuffer(),
        mint.toBuffer(),
        u64le(fixedPrice),
        i64le(BigInt(expiryTs)),
        u64le(nonce),
      ],
      PROGRAM_ID
    )[0];
  }

  assetPricePda(expiryTs: number, mint: PublicKey = this.mint): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("asset_price"), mint.toBuffer(), i64le(BigInt(expiryTs))],
      PROGRAM_ID
    )[0];
  }

  async openAssetPosition(p: OpenArgs) {
    const user = p.user ?? this.user;
    const mm = p.mm ?? this.mm;
    const usdc = p.usdcMint ?? this.usdcMint.publicKey;
    const mint = this.mint;
    const position = this.assetPositionPda(
      user.publicKey,
      mm.publicKey,
      p.fixedPrice,
      p.expiryTs,
      p.nonce
    );
    const ix = await this.program.methods
      .openAssetPosition({
        product: p.product as any,
        fixedPrice: new BN(p.fixedPrice.toString()),
        expiryTs: new BN(p.expiryTs),
        amount: new BN(p.amount.toString()),
        yieldAmount: new BN(p.yieldAmount.toString()),
        nonce: new BN(p.nonce.toString()),
      })
      .accountsStrict({
        marketMaker: mm.publicKey,
        user: user.publicKey,
        config: this.config,
        asset: this.assetPda(mint),
        assetMint: mint,
        usdcMint: usdc,
        position,
        positionAssetVault: this.ata(position, mint),
        positionUsdcVault: this.ata(position, usdc),
        userAssetAta: this.ata(user.publicKey, mint),
        userUsdcAta: this.ata(user.publicKey, usdc),
        mmAssetAta: this.ata(mm.publicKey, mint),
        mmUsdcAta: this.ata(mm.publicKey, usdc),
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    const res = this.send([ix], [mm, user], mm.publicKey);
    return { res, position };
  }

  async fetchAssetPosition(position: PublicKey) {
    const acc = this.svm.getAccount(position);
    if (!acc) throw new Error("asset position account missing");
    return this.program.coder.accounts.decode(
      "assetPosition",
      Buffer.from(acc.data)
    );
  }

  async fetchAssetPrice(expiryTs: number) {
    const acc = this.svm.getAccount(this.assetPricePda(expiryTs));
    if (!acc) throw new Error("asset settlement price missing");
    return this.program.coder.accounts.decode(
      "assetSettlementPrice",
      Buffer.from(acc.data)
    );
  }

  async postAssetPrice(
    expiryTs: number,
    price: bigint,
    poster: Keypair = this.poster
  ) {
    const ix = await this.program.methods
      .postAssetSettlementPrice(new BN(expiryTs), new BN(price.toString()))
      .accountsStrict({
        poster: poster.publicKey,
        config: this.config,
        asset: this.assetPda(),
        settlementPrice: this.assetPricePda(expiryTs),
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    return this.send([ix], [poster]);
  }

  async overrideAssetPrice(
    expiryTs: number,
    price: bigint,
    signers: Keypair[],
    payer: Keypair = this.outsider
  ) {
    const ix = await this.program.methods
      .overrideAssetSettlementPrice(new BN(expiryTs), new BN(price.toString()))
      .accountsStrict({
        payer: payer.publicKey,
        config: this.config,
        asset: this.assetPda(),
        settlementPrice: this.assetPricePda(expiryTs),
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(
        signers.map((s) => ({
          pubkey: s.publicKey,
          isSigner: true,
          isWritable: false,
        }))
      )
      .instruction();
    return this.send([ix], [payer, ...signers]);
  }

  private async payoutAccounts(position: PublicKey) {
    const pos = await this.fetchAssetPosition(position);
    const usdc = this.usdcMint.publicKey;
    return {
      pos,
      accounts: {
        config: this.config,
        position,
        user: pos.user,
        marketMaker: pos.marketMaker,
        assetMint: pos.assetMint,
        usdcMint: usdc,
        positionAssetVault: this.ata(position, pos.assetMint),
        positionUsdcVault: this.ata(position, usdc),
        userAssetAta: this.ata(pos.user, pos.assetMint),
        userUsdcAta: this.ata(pos.user, usdc),
        mmAssetAta: this.ata(pos.marketMaker, pos.assetMint),
        mmUsdcAta: this.ata(pos.marketMaker, usdc),
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      },
    };
  }

  async settleAsset(position: PublicKey, caller: Keypair = this.outsider) {
    const { pos, accounts } = await this.payoutAccounts(position);
    const ix = await this.program.methods
      .settleAssetPosition()
      .accountsStrict({
        ...accounts,
        caller: caller.publicKey,
        settlementPrice: this.assetPricePda(pos.expiryTs.toNumber()),
      })
      .instruction();
    return this.send([ix], [caller]);
  }

  async emergencyCancelAsset(
    position: PublicKey,
    signers: Keypair[],
    payer: Keypair = this.outsider
  ) {
    const { accounts } = await this.payoutAccounts(position);
    const ix = await this.program.methods
      .emergencyCancelAssetPosition()
      .accountsStrict({ ...accounts, payer: payer.publicKey })
      .remainingAccounts(
        signers.map((s) => ({
          pubkey: s.publicKey,
          isSigner: true,
          isWritable: false,
        }))
      )
      .instruction();
    return this.send([ix], [payer, ...signers]);
  }
}

export function alignedExpiryAt(
  daysAhead: number,
  timeOfDay: number,
  from = NOW
): number {
  const day = Math.floor(from / DAY) * DAY;
  return day + daysAhead * DAY + timeOfDay;
}

export interface OpenArgs {
  product: Product;
  fixedPrice: bigint;
  expiryTs: number;
  amount: bigint;
  yieldAmount: bigint;
  nonce: bigint;
  user?: Keypair;
  mm?: Keypair;
  usdcMint?: PublicKey;
}

export function u64le(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
}

export function i64le(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(n);
  return b;
}

export function isFailed(
  res: TransactionMetadata | FailedTransactionMetadata
): res is FailedTransactionMetadata {
  return res instanceof FailedTransactionMetadata;
}

export function expectOk(
  res: TransactionMetadata | FailedTransactionMetadata
): TransactionMetadata {
  if (isFailed(res)) {
    throw new Error(
      `transaction failed: ${res.err().toString()}\n${res.meta().prettyLogs()}`
    );
  }
  return res;
}

/** Assert failure with an Anchor error code name or any substring of the logs / error. */
export function expectErr(
  res: TransactionMetadata | FailedTransactionMetadata,
  needle: string
) {
  if (!isFailed(res)) {
    throw new Error(
      `expected failure containing "${needle}" but transaction succeeded:\n${res.prettyLogs()}`
    );
  }
  const text = res.meta().logs().join("\n") + "\n" + res.err().toString();
  expect(text, `expected "${needle}" in:\n${text}`).to.include(needle);
}

let nonceCounter = 1n;
export function nextNonce(): bigint {
  return nonceCounter++;
}
