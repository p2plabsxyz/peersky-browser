import { app } from "electron";
import path from "path";
import fs from "fs-extra";
import crypto from "hypercore-crypto";
import { libp2pOptions } from "./helia/libp2p.js";

const USER_DATA = app.getPath("userData");
const DEFAULT_IPFS_DIR = path.join(USER_DATA, "ipfs");
const DEFAULT_HYPER_DIR = path.join(USER_DATA, "hyper");
const KEYPAIR_PATH = path.join(DEFAULT_HYPER_DIR, "swarm-keypair.json");

// Try loading an existing keypair from disk
function loadKeyPair() {
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
function saveKeyPair(keyPair) {
  fs.writeJsonSync(KEYPAIR_PATH, {
    publicKey: keyPair.publicKey.toString("hex"),
    secretKey: keyPair.secretKey.toString("hex")
  });
}

// Retrieve an existing keypair or generate a new one if needed.
let keyPair = loadKeyPair();
if (!keyPair) {
  keyPair = crypto.keyPair();
  saveKeyPair(keyPair);
}

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
  keyPair,
};
