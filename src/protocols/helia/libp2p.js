import { createLibp2p } from "libp2p";
import { tcp } from "@libp2p/tcp";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { mdns } from "@libp2p/mdns";
import { mplex } from "@libp2p/mplex";
import { webRTC, webRTCDirect } from "@libp2p/webrtc";
import { kadDHT } from "@libp2p/kad-dht";
import { webSockets } from "@libp2p/websockets";
import { bootstrap } from "@libp2p/bootstrap";
import { gossipsub } from "@chainsafe/libp2p-gossipsub";
import { identify, identifyPush } from "@libp2p/identify";
import {
  circuitRelayTransport,
  circuitRelayServer,
} from "@libp2p/circuit-relay-v2";

// this list comes from https://github.com/ipfs/kubo/blob/da28fbc65a2e0f1ce59f9923823326ae2bc4f713/config/bootstrap_peers.go#L17
const bootstrapConfig = {
  list: [
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb",
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt",
    "/ip4/104.131.131.82/tcp/4001/p2p/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ",
  ],
};

const agentVersion = "p2plabsxyz/peersky-browser";

export async function libp2pOptions() {
  return await createLibp2p({
    addresses: {
      listen: ["/ip4/0.0.0.0/tcp/0", "/ip6/::/tcp/0", "/webrtc"],
    },
    transports: [
      tcp(),
      webRTC(),
      webRTCDirect(),
      webSockets(),
      circuitRelayTransport(),
    ],
    connectionEncryption: [noise()],
    streamMuxers: [yamux(), mplex()],
    peerDiscovery: [mdns(), bootstrap(bootstrapConfig)],
    services: {
      dht: kadDHT({
        clientMode: false, // Disable DHT
      }),
      pubsub: gossipsub({
        emitSelf: true, // Enable pubsub
      }),
      identify: identify({
        agentVersion,
      }),
      identifyPush: identifyPush({ agentVersion }),
    },
    relay: circuitRelayServer(),
  });
}
