import { app } from "electron";
import path from "path";
import { libp2pOptions } from "./helia/libp2p.js";

const USER_DATA = app.getPath("userData");
const DEFAULT_IPFS_DIR = path.join(USER_DATA, "ipfs");
const DEFAULT_HYPER_DIR = path.join(USER_DATA, "hyper");

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
