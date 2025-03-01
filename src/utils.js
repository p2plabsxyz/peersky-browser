// P2P prefixes
const IPFS_PREFIX = 'ipfs://';
const IPNS_PREFIX = 'ipns://';
const HYPER_PREFIX = 'hyper://';
const WEB3_PREFIX = 'web3://';

// Utility functions
function isURL(string) {
  try {
    new URL(string);
    return true;
  } catch {
    return false;
  }
}

function looksLikeDomain(string) {
  return !string.match(/\s/) && string.includes('.');
}

function isBareLocalhost(string) {
  return string.match(/^localhost(:[0-9]+)?\/?$/);
}

function makeHttp(query) {
  return `http://${query}`;
}

function makeHttps(query) {
  return `https://${query}`;
}

function makeDuckDuckGo(query) {
  return `https://duckduckgo.com/?q=${encodeURIComponent(query)}`;
}

function handleURL(rawURL) {
  if (rawURL.endsWith('.eth')) {
    if (rawURL.startsWith(IPFS_PREFIX) || rawURL.startsWith(IPNS_PREFIX)) {
      return rawURL;
    }
    // ENS names are mutable and should be resolved via IPNS.
    return `${IPNS_PREFIX}${rawURL}`;
  } else if (
    rawURL.startsWith(IPFS_PREFIX) || 
    rawURL.startsWith(IPNS_PREFIX) || 
    rawURL.startsWith(HYPER_PREFIX) || 
    rawURL.startsWith(WEB3_PREFIX)
  ) {
    return rawURL;
  } else if (isURL(rawURL)) {
    return rawURL;
  } else if (isBareLocalhost(rawURL)) {
    return makeHttp(rawURL);
  } else if (looksLikeDomain(rawURL)) {
    return makeHttps(rawURL);
  } else {
    return makeDuckDuckGo(rawURL);
  }
}

export {
  IPFS_PREFIX,
  IPNS_PREFIX,
  HYPER_PREFIX,
  WEB3_PREFIX,
  handleURL,
  makeHttp,
  makeHttps,
  makeDuckDuckGo,
};
