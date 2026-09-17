export function connectionFor (protocol) {
  switch (protocol) {
    case 'http:':
      return { secure: false, label: 'Not secure' }
    case 'https:':
      return { secure: true, label: 'Connection is secure' }
    case 'peersky:':
      return { secure: true, label: 'PeerSky page' }
    case 'ipfs:':
    case 'ipns:':
      return { secure: true, label: 'IPFS' }
    case 'hyper:':
      return { secure: true, label: 'Hypercore' }
    case 'bt:':
    case 'bittorrent:':
    case 'magnet:':
      return { secure: true, label: 'BitTorrent' }
    case 'web3:':
      return { secure: true, label: 'Web3' }
    case 'file:':
      return { secure: true, label: 'Local file' }
    default:
      return { secure: false, label: 'Connection status unknown' }
  }
}
