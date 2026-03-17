async function probeFetch(url, init) {
  try {
    const response = await fetch(url, init);
    return {
      status: response.status,
      ok: response.ok,
      error: null,
    };
  } catch (error) {
    return {
      status: null,
      ok: false,
      error: String(error && error.message ? error.message : error),
    };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "probe") {
    return;
  }

  (async () => {
    const current = await chrome.storage.local.get("probeRuns");
    const probeRuns = (current && current.probeRuns ? current.probeRuns : 0) + 1;
    await chrome.storage.local.set({ probeRuns });

    const peersky = await probeFetch("peersky://home");
    const hyper = await probeFetch("hyper://fixture/hello.txt");
    const ipfs = await probeFetch("ipfs://bafyfixture/index.html");
    const hyperWrite = await probeFetch("hyper://fixture/write.txt", { method: "PUT", body: "blocked-write" });
    const ipfsWrite = await probeFetch("ipfs://bafyfixture/write.txt", { method: "PUT", body: "blocked-write" });

    sendResponse({
      probeRuns,
      peerskyStatus: peersky.status,
      peerskyOk: peersky.ok,
      peerskyError: peersky.error,
      hyperStatus: hyper.status,
      hyperOk: hyper.ok,
      hyperError: hyper.error,
      ipfsStatus: ipfs.status,
      ipfsOk: ipfs.ok,
      ipfsError: ipfs.error,
      hyperWriteStatus: hyperWrite.status,
      hyperWriteError: hyperWrite.error,
      ipfsWriteStatus: ipfsWrite.status,
      ipfsWriteError: ipfsWrite.error,
    });
  })().catch((error) => {
    const fallbackError = String(error && error.message ? error.message : error);
    sendResponse({
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
    });
  });

  return true;
});
