import { createHelia } from "helia";
import { createLibp2p } from "libp2p";
import { libp2pDefaults } from "helia";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { mplex } from "@libp2p/mplex";
import { mdns } from "@libp2p/mdns";
import { tcp } from "@libp2p/tcp";
import { webRTC, webRTCDirect } from "@libp2p/webrtc";
import { webSockets } from "@libp2p/websockets";
import { quic } from "@chainsafe/libp2p-quic";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { autoNAT } from "@libp2p/autonat";
import { uPnPNAT } from "@libp2p/upnp-nat";
import { dcutr } from "@libp2p/dcutr";
import { kadDHT } from "@libp2p/kad-dht";
import { gossipsub } from "@chainsafe/libp2p-gossipsub";
import { ping } from "@libp2p/ping";
import { identify, identifyPush } from "@libp2p/identify";
import { bootstrap } from "@libp2p/bootstrap";
import { createDelegatedRoutingV1HttpApiClient } from "@helia/delegated-routing-v1-http-api-client";
import { delegatedHTTPRoutingDefaults } from "@helia/routers";
import { ipnsValidator } from "ipns/validator";
import { ipnsSelector } from "ipns/selector";
import { ipfsOptions } from "../config.js";

const bootstrapConfig = {
  list: [
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb",
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt",
    "/ip4/104.131.131.82/tcp/4001/p2p/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ",
  ],
};

export async function createNode() {
  const options = await ipfsOptions();

  const defaults = libp2pDefaults();

  const libp2p = await createLibp2p({
    ...defaults,
    addresses: {
      listen: [
        "/ip4/0.0.0.0/tcp/0",
        "/ip4/0.0.0.0/tcp/0/ws",
        "/ip4/0.0.0.0/udp/0/quic-v1",
        "/webrtc",
        "/p2p-circuit",
      ],
    },
    transports: [
      tcp(),
      webSockets(),
      quic(),
      webRTC(),
      webRTCDirect(),
      circuitRelayTransport({
        discoverRelays: 2,
      }),
    ],
    connectionEncryption: [noise()],
    streamMuxers: [yamux(), mplex()],
    peerDiscovery: [
      mdns(),
      bootstrap(bootstrapConfig),
    ],
    services: {
      ...defaults.services,
      upnpNAT: uPnPNAT(),
      autoNAT: autoNAT(),
      dcutr: dcutr(),
      delegatedRouting: () => createDelegatedRoutingV1HttpApiClient('https://delegated-ipfs.dev', delegatedHTTPRoutingDefaults()),
      dht: kadDHT({
        clientMode: false,
        validators: { ipns: ipnsValidator },
        selectors: { ipns: ipnsSelector },
      }),
      pubsub: gossipsub(),
      identify: identify(),
      identifyPush: identifyPush(),
      ping: ping(),
    },
    connectionManager: {
      maxConnections: 500,
      minConnections: 100,
      maxParallelDials: 100,
      maxParallelDialsPerPeer: 10,
      dialTimeout: 30000,
      autoDial: true,
    },
    connectionGater: {
      // denyDialMultiaddr: async (multiaddr) => {
      //   console.log(`Checking multiaddr: ${multiaddr.toString()}`);
      //   return false;
      // },
      // denyDialPeer: async (peerId) => {
      //   console.log(`Checking peer: ${peerId.toString()}`);
      //   return false;
      // },
      // denyInboundConnection: async () => false,
      // denyOutboundConnection: async () => false,
      // denyInboundEncryptedConnection: async () => false,
      // denyOutboundEncryptedConnection: async () => false,
      // denyInboundUpgrade: async () => false,
      // denyOutboundUpgrade: async () => false,
      // filterMultiaddrForPeer: async (multiaddr, peerId) => {
      //   const isRelayed = multiaddr.toString().includes("/p2p-circuit");
      //   console.log(`Filtering multiaddr for peer ${peerId}: ${multiaddr} - relayed: ${isRelayed}`);
      //   return true;
      // },
    },
  });

  const node = await createHelia({
    ...options,
    libp2p,
    refresh: false,
    status: true,
    block: true
  });

  // Debug logging for node connectivity
  // node.libp2p.addEventListener("self:peer:update", () => {
  //   console.log("Node multiaddrs:", node.libp2p.getMultiaddrs().map(ma => ma.toString()));
  // });
  // node.libp2p.addEventListener("peer:connect", (evt) => {
  //   console.log(`Connected to peer: ${evt.detail.toString()}`);
  // });

  return node;
}
