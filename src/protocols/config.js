import { app } from "electron";
import path from "path";
import { libp2pOptions } from "./helia/libp2p.js";
import fs from "fs-extra";
import { getDefaultChainList } from "web3protocol/chains";

const USER_DATA = app.getPath("userData");
const DEFAULT_IPFS_DIR = path.join(USER_DATA, "ipfs");
const DEFAULT_HYPER_DIR = path.join(USER_DATA, "hyper");
const ENS_CACHE = path.join(USER_DATA, "ensCache.json");

export const ipfsOptions = {
  libp2p: await libp2pOptions(),
  repo: DEFAULT_IPFS_DIR,
  silent: true,
  preload: {
    enabled: false,
  },
  config: {
    Addresses: {
      Swarm: [
        "/ip4/0.0.0.0/tcp/4002",
        "/ip4/0.0.0.0/udp/4002/quic",
        "/ip6/::/tcp/4002",
        "/ip6/::/udp/4002/quic",
      ],
    },
    Gateway: null,
  },
};

export const hyperOptions = {
  // All options here: https://github.com/datproject/sdk/#const-hypercore-hyperdrive-resolvename-keypair-derivesecret-registerextension-close--await-sdkopts
  storage: DEFAULT_HYPER_DIR,
};

// Dynamically fetch RPC URL from default chain list
let RPC_URL = null;

(async () => {
  const chainList = getDefaultChainList();
  const targetChainId = 1; // Ethereum mainnet
  const targetChain = chainList.find((chain) => chain.id === targetChainId);

  if (targetChain && targetChain.rpcUrls?.length > 0) {
    RPC_URL = targetChain.rpcUrls[0]; // Use the first RPC URL
  } else {
    console.error(`Could not find RPC URL for chain ${targetChainId}`);
  }
})();

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
export { ensCache, RPC_URL };
