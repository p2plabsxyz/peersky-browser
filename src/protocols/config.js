import { app } from "electron";
import { LevelBlockstore } from "blockstore-level";
import { LevelDatastore } from "datastore-level";
import path from "path";
import fs from "fs-extra";
import crypto from "hypercore-crypto";
import { getDefaultChainList } from "web3protocol/chains";
import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from "@libp2p/crypto/keys";

const USER_DATA = app.getPath("userData");
const DEFAULT_IPFS_DIR = path.join(USER_DATA, "ipfs");
const BLOCKSTORE_PATH = path.join(DEFAULT_IPFS_DIR, "blocks");
const DATASTORE_PATH = path.join(DEFAULT_IPFS_DIR, "datastore"); 
const DEFAULT_HYPER_DIR = path.join(USER_DATA, "hyper");
const ENS_CACHE = path.join(USER_DATA, "ensCache.json");
const KEYPAIR_PATH = path.join(DEFAULT_HYPER_DIR, "swarm-keypair.json");
const LIBP2P_KEY_PATH = path.join(DEFAULT_IPFS_DIR, "libp2p-key");

// Try loading an existing keypair from disk
export function loadKeyPair() {
  if (fs.existsSync(KEYPAIR_PATH)) {
    const data = fs.readJsonSync(KEYPAIR_PATH);
    return {
      publicKey: Buffer.from(data.publicKey, "hex"),
      secretKey: Buffer.from(data.secretKey, "hex")
    };
  }
  return null;
}

// Save a new keypair to disk
export function saveKeyPair(keyPair) {
  // Ensure the hyper directory exists
  fs.ensureDirSync(DEFAULT_HYPER_DIR);

  fs.writeJsonSync(KEYPAIR_PATH, {
    publicKey: keyPair.publicKey.toString("hex"),
    secretKey: keyPair.secretKey.toString("hex")
  });
}

// Load the libp2p private key from disk (for Helia)
export async function loadLibp2pKey() {
  try {
    const raw = await fs.promises.readFile(LIBP2P_KEY_PATH);
    console.log(`Loaded libp2p key from ${LIBP2P_KEY_PATH}`);
    return privateKeyFromProtobuf(new Uint8Array(raw));
  } catch (err) {
    if (err.code === "ENOENT") {
      console.log(`No libp2p key found at ${LIBP2P_KEY_PATH}, will generate a new one`);
      return null;
    }
    throw err;
  }
}

// Save the libp2p private key to disk (for Helia)
export async function saveLibp2pKey(privateKey) {
  try {
    await fs.promises.mkdir(path.dirname(LIBP2P_KEY_PATH), { recursive: true });
    const pb = privateKeyToProtobuf(privateKey);
    await fs.promises.writeFile(LIBP2P_KEY_PATH, Buffer.from(pb));
    console.log(`Saved libp2p key to ${LIBP2P_KEY_PATH}`);
  } catch (err) {
    console.error(`Error saving libp2p key: ${err.message}`);
    throw err;
  }
}

// Get or generate a persistent private key for Helia
export async function getLibp2pPrivateKey() {
  let privateKey = await loadLibp2pKey();
  if (!privateKey) {
    privateKey = await generateKeyPair("Ed25519");
    await saveLibp2pKey(privateKey);
  }
  return privateKey;
}

export async function ipfsOptions() {
  await fs.ensureDir(BLOCKSTORE_PATH);
  await fs.ensureDir(DATASTORE_PATH);
  return {
    repo: DEFAULT_IPFS_DIR,
    blockstore: new LevelBlockstore(BLOCKSTORE_PATH),
    datastore: new LevelDatastore(DATASTORE_PATH),
  };
}

export const hyperOptions = {
  // All options here: https://github.com/datproject/sdk/#const-hypercore-hyperdrive-resolvename-keypair-derivesecret-registerextension-close--await-sdkopts
  storage: DEFAULT_HYPER_DIR,
};

// Initialize RPC_URL using top-level await (avoiding an async IIFE)
const chainList = await getDefaultChainList();
const targetChainId = 1; // Ethereum mainnet
const targetChain = chainList.find((chain) => chain.id === targetChainId);
export const RPC_URL =
  targetChain && targetChain.rpcUrls?.length > 0
    ? targetChain.rpcUrls[0]
    : (console.error(`Could not find RPC URL for chain ${targetChainId}`), null);

// Initialize or load ENS cache
let ensCache = new Map();
if (fs.existsSync(ENS_CACHE)) {
  try {
    const data = fs.readFileSync(ENS_CACHE, "utf-8");
    const parsedData = JSON.parse(data);
    ensCache = new Map(parsedData);
  } catch (error) {
    console.error("Failed to load ENS cache from file:", error);
  }
} else {
  console.log(
    "No existing ENS cache file found. Starting with an empty cache."
  );
}

// Function to save cache to file
export function saveEnsCache() {
  try {
    const data = JSON.stringify(Array.from(ensCache.entries()), null, 2);
    fs.writeFileSync(ENS_CACHE, data, "utf-8");
    console.log("ENS cache saved to file.");
  } catch (error) {
    console.error("Failed to save ENS cache to file:", error);
  }
}

// Export the cache and save function
export { ensCache };
