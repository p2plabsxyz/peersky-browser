// @ts-check
import { createHelia } from "helia";
import { createLibp2p } from "libp2p";
import { libp2pDefaults } from "helia";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { mdns } from "@libp2p/mdns";
import { tcp } from "@libp2p/tcp";
import { webRTC, webRTCDirect } from "@libp2p/webrtc";
import { webSockets } from "@libp2p/websockets";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { autoNAT } from "@libp2p/autonat";
import { autoTLS } from '@ipshipyard/libp2p-auto-tls'
import { uPnPNAT } from "@libp2p/upnp-nat";
import { dcutr } from "@libp2p/dcutr";
import { kadDHT, removePrivateAddressesMapper } from "@libp2p/kad-dht";
import { ping } from "@libp2p/ping";
import { identify, identifyPush } from "@libp2p/identify";
import { bootstrap } from "@libp2p/bootstrap";
import { createDelegatedRoutingV1HttpApiClient } from "@helia/delegated-routing-v1-http-api-client";
import { delegatedHTTPRoutingDefaults } from "@helia/routers";
import { ipnsValidator } from "ipns/validator";
import { ipnsSelector } from "ipns/selector";
import { userAgent } from "libp2p/user-agent";
import { ipfsOptions, getLibp2pPrivateKey } from "../config.js";
import pkg from '../../../package.json' with { type: 'json' };
const { version } = pkg;

// https://github.com/ipfs/helia/blob/main/packages/helia/src/utils/bootstrappers.ts
const bootstrapConfig = {
  list: [
    '/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
    '/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb',
    '/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt',
    // va1 is not in the TXT records for _dnsaddr.bootstrap.libp2p.io yet
    // so use the host name directly
    '/dnsaddr/va1.bootstrap.libp2p.io/p2p/12D3KooWKnDdG3iXw9eTFijk3EWSunZcFi54Zka4wmtqtt6rPxc8',
    '/ip4/104.131.131.82/tcp/4001/p2p/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ'
  ]
}

export async function createNode() {
  const options = await ipfsOptions();

  const privateKey = await getLibp2pPrivateKey();
  const agentVersion = `peersky-browser/${version} ${userAgent()}`;

  const defaults = libp2pDefaults({ privateKey });

  const libp2p = await createLibp2p({
    ...defaults,
    nodeInfo: {
      userAgent: agentVersion
    },
    addresses: {
      listen: [
        '/ip4/0.0.0.0/tcp/0',
        '/ip4/0.0.0.0/tcp/0/ws',
        '/ip4/0.0.0.0/udp/0/webrtc-direct',
        '/ip6/::/udp/0/webrtc-direct',
        '/p2p-circuit'
      ],
    },
    transports: [
      tcp(),
      webSockets(),
      webRTC(),
      webRTCDirect(),
      circuitRelayTransport(),
    ],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    peerDiscovery: [
      mdns(),
      bootstrap(bootstrapConfig),
    ],
    services: {
      ...defaults.services,
      autoNAT: autoNAT(),
      autoTLS: autoTLS(),
      dcutr: dcutr(),
      delegatedRouting: () => createDelegatedRoutingV1HttpApiClient('https://delegated-ipfs.dev', delegatedHTTPRoutingDefaults()),
      aminoDHT: kadDHT({
        protocol: '/ipfs/kad/1.0.0',
        peerInfoMapper: removePrivateAddressesMapper,
        validators: { ipns: ipnsValidator },
        selectors: { ipns: ipnsSelector },
        reprovide: { 
          concurrency: 10,
          interval: 60 * 60 * 1000,
          threshold: 12 * 60 * 60 * 1000
        }
      }),
      identify: identify(),
      identifyPush: identifyPush(),
      ping: ping(),
      upnpNAT: uPnPNAT(),
    },
    connectionManager: {
      maxConnections: 500,
      inboundConnectionThreshold: 100,
      maxIncomingPendingConnections: 100,
    },
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

  console.log("Peer ID:", node.libp2p.peerId.toString());
  console.log("Node userAgent:", agentVersion);

  return node;
}
