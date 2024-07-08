import { create as createSDK } from 'hyper-sdk';
import makeHyperFetch from 'hypercore-fetch';
import { Readable } from 'stream';

// Initialize the SDK and create the fetch function
async function initializeHyperSDK(options) {
  const sdk = await createSDK(options);
  const fetch = makeHyperFetch({
    sdk: sdk,
    writable: true
  });

  return fetch;
}

// Create the Hyper protocol handler
export async function createHandler(options, session) {
  const fetch = await initializeHyperSDK(options);

  return async function protocolHandler(req, callback) {
    const { url, method = 'GET', headers = {}, body = null } = req;

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: method !== 'GET' ? Readable.from(body) : undefined
      });

      // Collect the response data to send back
      const chunks = [];
      const reader = response.body.getReader();
      let readResult;
      while (!(readResult = await reader.read()).done) {
        chunks.push(readResult.value);
      }
      const data = Buffer.concat(chunks);

      callback({
        statusCode: response.status,
        headers: Object.fromEntries(response.headers),
        data: Readable.from(data)
      });
    } catch (e) {
      console.error('Failed to handle Hyper request:', e);
      callback({
        statusCode: 500,
        headers: { 'Content-Type': 'text/plain' },
        data: Readable.from(`Error handling Hyper request: ${e.message}`)
      });
    }
  };
}
