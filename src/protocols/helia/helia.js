// @ts-check
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
import { circuitRelayTransport, circuitRelayServer } from "@libp2p/circuit-relay-v2";
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
      circuitRelayTransport(),
    ],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux(), mplex()],
    peerDiscovery: [
      mdns(),
      bootstrap(bootstrapConfig),
    ],
    services: {
      ...defaults.services,
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
      relay: circuitRelayServer(),
      upnpNAT: uPnPNAT(),
    },
    connectionManager: {
      maxConnections: 500,
      maxParallelDials: 100,
    },
    connectionGater: {
      filterMultiaddrForPeer: async (multiaddr, peerId) => {
        const maStr = multiaddr.toString();
      
        const privateIpPatterns = [
          /\/ip4\/10\./,
          /\/ip4\/172\.(1[6-9]|2[0-9]|3[0-1])\./,
          /\/ip4\/192\.168\./,
          /\/ip4\/127\./
        ];
      
        const isPrivate = privateIpPatterns.some(pattern => pattern.test(maStr));
        const isRelayed = maStr.includes("/p2p-circuit");
      
        // Reject private IPs if not relayed
        if (isPrivate && !isRelayed) {
          console.log(`REJECTING private multiaddr for peer ${peerId}: ${maStr}`);
          return false;
        }
      
        // Optionally log only allowed relayed
        // if (isRelayed) {
        //   console.log(`ALLOWING relayed multiaddr for peer ${peerId}: ${maStr}`);
        // }
      
        return true;
      }
    }
  });

  /** @type {any} */
  const ds = options.datastore;
  /** @type {any} */
  const bs = options.blockstore;

  const node = await createHelia({
    ...options,
    libp2p,
    datastore: ds,
    blockstore: bs,
  });

  return node;
}
