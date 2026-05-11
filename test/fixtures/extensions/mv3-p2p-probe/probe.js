function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendProbeMessage() {
  return chrome.runtime.sendMessage({ type: "probe" });
}

async function fetchRequest(url, init) {
  try {
    const response = await fetch(url, init);
    return { status: response.status, error: null };
  } catch (error) {
    return { status: null, error: String(error && error.message ? error.message : error) };
  }
}

function xhrRequest(url, method = "GET", body = null) {
  return new Promise((resolve) => {
    try {
      const xhr = new XMLHttpRequest();
      xhr.open(method, url, true);
      xhr.onreadystatechange = function onReadyStateChange() {
        if (xhr.readyState === 4) {
          if (xhr.status === 0) {
            resolve({ status: null, error: "xhr-status-0" });
          } else {
            resolve({ status: xhr.status, error: null });
          }
        }
      };
      xhr.onerror = function onError() {
        resolve({ status: null, error: "xhr-error" });
      };
      xhr.send(body);
    } catch (error) {
      resolve({ status: null, error: String(error && error.message ? error.message : error) });
    }
  });
}

window.__runProbe = async function runProbe() {
  const hasNode = typeof require !== "undefined" || typeof process !== "undefined";

  let lastError = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const result = await sendProbeMessage();
      const pageFetchPeersky = await fetchRequest("peersky://home");
      const pageFetchHyper = await fetchRequest("hyper://fixture/page-fetch.txt");
      const pageFetchIpfs = await fetchRequest("ipfs://bafyfixture/page-fetch.txt");
      const pageWriteHyper = await fetchRequest("hyper://fixture/page-write.txt", { method: "PUT", body: "blocked" });
      const pageWriteIpfs = await fetchRequest("ipfs://bafyfixture/page-write.txt", { method: "PUT", body: "blocked" });
      const xhrPeersky = await xhrRequest("peersky://home");
      const xhrHyper = await xhrRequest("hyper://fixture/xhr.txt");
      const xhrIpfs = await xhrRequest("ipfs://bafyfixture/xhr.txt");
      const xhrWriteHyper = await xhrRequest("hyper://fixture/xhr-write.txt", "PUT", "blocked");
      const xhrWriteIpfs = await xhrRequest("ipfs://bafyfixture/xhr-write.txt", "PUT", "blocked");
      return {
        hasNode,
        ...result,
        pageFetchPeerskyStatus: pageFetchPeersky.status,
        pageFetchPeerskyError: pageFetchPeersky.error,
        pageFetchHyperStatus: pageFetchHyper.status,
        pageFetchHyperError: pageFetchHyper.error,
        pageFetchIpfsStatus: pageFetchIpfs.status,
        pageFetchIpfsError: pageFetchIpfs.error,
        pageWriteHyperStatus: pageWriteHyper.status,
        pageWriteHyperError: pageWriteHyper.error,
        pageWriteIpfsStatus: pageWriteIpfs.status,
        pageWriteIpfsError: pageWriteIpfs.error,
        xhrPeerskyStatus: xhrPeersky.status,
        xhrPeerskyError: xhrPeersky.error,
        xhrHyperStatus: xhrHyper.status,
        xhrHyperError: xhrHyper.error,
        xhrIpfsStatus: xhrIpfs.status,
        xhrIpfsError: xhrIpfs.error,
        xhrWriteHyperStatus: xhrWriteHyper.status,
        xhrWriteHyperError: xhrWriteHyper.error,
        xhrWriteIpfsStatus: xhrWriteIpfs.status,
        xhrWriteIpfsError: xhrWriteIpfs.error,
      };
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }

  const fallbackError = String(lastError && lastError.message ? lastError.message : lastError || "unknown");
  return {
    hasNode,
    probeRuns: -1,
    peerskyStatus: null,
    peerskyOk: false,
    peerskyError: fallbackError,
    hyperStatus: null,
    hyperOk: false,
    hyperError: fallbackError,
    ipfsStatus: null,
    ipfsOk: false,
    ipfsError: fallbackError,
    hyperWriteStatus: null,
    hyperWriteError: fallbackError,
    ipfsWriteStatus: null,
    ipfsWriteError: fallbackError,
    pageFetchPeerskyStatus: null,
    pageFetchPeerskyError: fallbackError,
    pageFetchHyperStatus: null,
    pageFetchHyperError: fallbackError,
    pageFetchIpfsStatus: null,
    pageFetchIpfsError: fallbackError,
    pageWriteHyperStatus: null,
    pageWriteHyperError: fallbackError,
    pageWriteIpfsStatus: null,
    pageWriteIpfsError: fallbackError,
    xhrPeerskyStatus: null,
    xhrPeerskyError: fallbackError,
    xhrHyperStatus: null,
    xhrHyperError: fallbackError,
    xhrIpfsStatus: null,
    xhrIpfsError: fallbackError,
    xhrWriteHyperStatus: null,
    xhrWriteHyperError: fallbackError,
    xhrWriteIpfsStatus: null,
    xhrWriteIpfsError: fallbackError,
  };
};
