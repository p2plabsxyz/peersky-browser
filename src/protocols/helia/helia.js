// @ts-check
import { createHelia } from "helia";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { mplex } from "@libp2p/mplex";
import { tls } from "@libp2p/tls";
import { mdns } from "@libp2p/mdns";
import { tcp } from "@libp2p/tcp";
import { webRTC, webRTCDirect } from "@libp2p/webrtc";
import { webSockets } from "@libp2p/websockets";
import { circuitRelayTransport, circuitRelayServer } from "@libp2p/circuit-relay-v2";
import { autoNAT } from "@libp2p/autonat";
import { autoTLS } from '@ipshipyard/libp2p-auto-tls';
import { uPnPNAT } from "@libp2p/upnp-nat";
import { dcutr } from "@libp2p/dcutr";
import { kadDHT } from "@libp2p/kad-dht";
import { ping } from "@libp2p/ping";
import { identify, identifyPush } from "@libp2p/identify";
import { bootstrap } from "@libp2p/bootstrap";
import { keychain } from "@libp2p/keychain";
import { http } from "@libp2p/http";
import { delegatedRoutingV1HttpApiClient } from "@helia/delegated-routing-v1-http-api-client";
import { ipnsValidator, ipnsSelector } from "@helia/ipns";
import { userAgent } from "libp2p/user-agent";
import { ipfsOptions, getLibp2pPrivateKey } from "../config.js";
import pkg from '../../../package.json' with { type: 'json' };
const { version } = pkg;
import { createLogger } from '../../logger.js';

const log = createLogger('protocols:ipfs');

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

  // helia@7 constructs libp2p itself during start(), injecting nodeInfo and
  // the datastore, so hand it options rather than a built instance.
  const libp2pOptions = {
    privateKey,
    nodeInfo: {
      userAgent: agentVersion
    },
    addresses: {
      listen: [
        '/ip4/0.0.0.0/tcp/0',
        '/ip4/0.0.0.0/tcp/0/ws',
        '/ip4/0.0.0.0/udp/0/webrtc-direct',
        '/ip6/::/tcp/0',
        '/ip6/::/tcp/0/ws',
        '/ip6/::/udp/0/webrtc-direct',
        '/p2p-circuit'
      ],
    },
    transports: [
      circuitRelayTransport({
        reservationConcurrency: 3
      }),
      tcp(),
      webRTC(),
      webRTCDirect(),
      webSockets(),
    ],
    connectionEncrypters: [noise(), tls()],
    streamMuxers: [yamux(), mplex()],
    peerDiscovery: [
      mdns(),
      bootstrap(bootstrapConfig),
    ],
    services: {
      autoNAT: autoNAT(),
      autoTLS: autoTLS({
        autoConfirmAddress: true
      }),
      dcutr: dcutr(),
      delegatedRouting: delegatedRoutingV1HttpApiClient({ url: 'https://delegated-ipfs.dev' }),
      dht: kadDHT({
        validators: { ipns: ipnsValidator },
        selectors: { ipns: ipnsSelector },
        clientMode: false,
        reprovide: {
          interval: 2147483647
        }
      }),
      identify: identify(),
      identifyPush: identifyPush(),
      keychain: keychain(),
      ping: ping(),
      upnp: uPnPNAT({
        autoConfirmAddress: true
      }),
      http: http(),
    },
    connectionManager: {
      maxConnections: 100,
      inboundConnectionThreshold: 50,
      maxIncomingPendingConnections: 50,
    },
  };

  /** @type {any} */
  const ds = options.datastore;
  /** @type {any} */
  const bs = options.blockstore;

  let dsOpened = false;
  let bsOpened = false;

  try {
    // datastore-level and blockstore-level implement open()/close() but not the
    // Startable interface (start()/stop()), so Helia's isStartable check skips them.
    // We must open them explicitly before createHelia calls helia.start().
    await ds.open();
    dsOpened = true;
    await bs.open();
    bsOpened = true;

    const node = await createHelia({
      ...options,
      libp2p: libp2pOptions,
      datastore: ds,
      blockstore: bs,
    });

    // libp2p is created during start(), and reading node.libp2p before that
    // throws NotStartedError.
    if (node.status !== "started") {
      await node.start();
    }

    log.info("Peer ID:", node.libp2p.peerId.toString());
    log.info("Node userAgent:", agentVersion);

    return node;
  } catch (error) {
    if (bsOpened) {
      try { await bs.close(); } catch (e) { log.warn("Failed to close blockstore after init failure:", e); }
    }
    if (dsOpened) {
      try { await ds.close(); } catch (e) { log.warn("Failed to close datastore after init failure:", e); }
    }
    throw error;
  }
}
