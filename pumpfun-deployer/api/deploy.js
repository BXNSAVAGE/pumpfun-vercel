// api/deploy.js — FINAL with Full Chrome Extension CORS Support

import bs58 from "bs58";
import * as borsh from "borsh";
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress, createSetAuthorityInstruction, AuthorityType } from "@solana/spl-token";
import { create } from "ipfs-http-client";
import { PROGRAM_ID as METADATA_PROGRAM_ID } from "@metaplex-foundation/mpl-token-metadata";

const PUMP_FUN_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const PUMP_GLOBAL = new PublicKey("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf");
const PUMP_EVENT_AUTHORITY = new PublicKey("Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1");
const SYSTEM_PROGRAM_ID = SystemProgram.programId;
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const RENT_SYSVAR = new PublicKey("SysvarRent111111111111111111111111111111111");

const ipfs = create({ url: 'https://ipfs.infura.io:5001/api/v0' });

class CreateInstructionData {
  constructor(fields) {
    Object.assign(this, fields);
  }
}

const CreateSchema = new Map([
  [CreateInstructionData, {
    kind: "struct",
    fields: [
      ["instruction", "u8"],
      ["name", [32]],
      ["symbol", [10]],
      ["uri", [200]],
      ["creator", [32]]
    ]
  }]
]);

export default async function handler(req, res) {
  // ✅ Full CORS headers for Chrome extension fetch
  res.setHeader("Access-Control-Allow-Origin", "chrome-extension://ldbonhcbhkfmgjalijhacohjgadpcpoj");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // ✅ Respond to OPTIONS preflight
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Only POST allowed' });

  try {
    const { tokenName, tokenSymbol, image, privateKey, rpc } = req.body;
    if (!tokenName || !tokenSymbol || !image || !privateKey) return res.status(400).json({ error: "Missing required fields" });

    const payer = Keypair.fromSecretKey(bs58.decode(privateKey));
    const connection = new Connection(rpc || "https://api.mainnet-beta.solana.com", "confirmed");

    const metadataJson = {
      name: tokenName,
      symbol: tokenSymbol,
      image: image,
      description: `Launched from Discord Pump Extension`,
      seller_fee_basis_points: 0,
      properties: { creators: [{ address: payer.publicKey.toBase58(), share: 100 }] }
    };

    const file = Buffer.from(JSON.stringify(metadataJson));
    const added = await ipfs.add(file);
    const uri = `https://ipfs.io/ipfs/${added.path}`;

    const mint = Keypair.generate();

    const [metadataPDA] = await PublicKey.findProgramAddress([
      Buffer.from("metadata"),
      METADATA_PROGRAM_ID.toBuffer(),
      mint.publicKey.toBuffer()
    ], METADATA_PROGRAM_ID);

    const [bondingCurvePDA] = await PublicKey.findProgramAddress([
      Buffer.from("bonding_curve"),
      mint.publicKey.toBuffer()
    ], PUMP_FUN_PROGRAM_ID);

    const [pumpPDA] = await PublicKey.findProgramAddress([
      Buffer.from("pump"),
      mint.publicKey.toBuffer()
    ], PUMP_FUN_PROGRAM_ID);

    const vaultATA = await getAssociatedTokenAddress(mint.publicKey, bondingCurvePDA, true);

    const data = new CreateInstructionData({
      instruction: 0,
      name: Array.from(Buffer.from(tokenName.padEnd(32))),
      symbol: Array.from(Buffer.from(tokenSymbol.padEnd(10))),
      uri: Array.from(Buffer.from(uri.padEnd(200))),
      creator: Array.from(payer.publicKey.toBytes())
    });

    const instruction = {
      programId: PUMP_FUN_PROGRAM_ID,
      keys: [
        { pubkey: mint.publicKey, isSigner: true, isWritable: true },
        { pubkey: bondingCurvePDA, isSigner: false, isWritable: true },
        { pubkey: vaultATA, isSigner: false, isWritable: true },
        { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false },
        { pubkey: METADATA_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: metadataPDA, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: RENT_SYSVAR, isSigner: false, isWritable: false },
        { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: PUMP_FUN_PROGRAM_ID, isSigner: false, isWritable: false }
      ],
      data: Buffer.from(borsh.serialize(CreateSchema, data))
    };

    const setAuthIx = createSetAuthorityInstruction(
      mint.publicKey,
      payer.publicKey,
      AuthorityType.MintTokens,
      pumpPDA,
      [],
      TOKEN_PROGRAM_ID
    );

    const tx = new Transaction().add(instruction).add(setAuthIx);
    tx.feePayer = payer.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    const signature = await sendAndConfirmTransaction(connection, tx, [payer, mint]);

    res.status(200).json({ success: true, tx: signature, mint: mint.publicKey.toBase58() });

  } catch (error) {
    console.error("Deploy Error:", error);
    res.status(500).json({ error: error.message });
  }
}
