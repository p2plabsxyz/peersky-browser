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

// Helper function to read and handle body data, especially for 'PUT' and 'POST'
async function readBody(bodyStream) {
  if (!bodyStream) return null;

  const reader = bodyStream.getReader();
  const chunks = [];
  let readResult;

  while (!(readResult = await reader.read()).done) {
    chunks.push(readResult.value);
  }

  // Convert chunks into a single buffer to handle multipart data or binary
  return Buffer.concat(chunks);
}

// Create the Hyper protocol handler
export async function createHandler(options, session) {
  const fetch = await initializeHyperSDK(options);

  return async function protocolHandler(req, callback) {
    const { url, method = 'GET', headers = {}, body = null } = req;

    try {
      const bodyContent = method !== 'GET' ? await readBody(body) : undefined;

      const response = await fetch(url, {
        method,
        headers,
        body: bodyContent ? Readable.from(bodyContent) : undefined,
      });

      // Collect the response data to send back
      const responseBody = await readBody(response.body);

      callback({
        statusCode: response.status,
        headers: Object.fromEntries(response.headers),
        data: Readable.from(responseBody)
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
