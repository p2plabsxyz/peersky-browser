import { create as createSDK } from 'hyper-sdk';
import makeHyperFetch from 'hypercore-fetch';
import { Readable } from 'stream';
import fs from "fs-extra";

// Initialize the SDK and create the fetch function
async function initializeHyperSDK(options) {
  const sdk = await createSDK(options);
  const fetch = makeHyperFetch({
    sdk: sdk,
    writable: true
  });

  return fetch;
}

async function * readBody (body, session) {
  for (const chunk of body) {
    if (chunk.bytes) {
      yield await Promise.resolve(chunk.bytes)
    } else if (chunk.blobUUID) {
      yield await session.getBlobData(chunk.blobUUID)
    } else if (chunk.file) {
      yield * Readable.from(fs.createReadStream(chunk.file))
    }
  }
}

// Create the Hyper protocol handler
export async function createHandler(options, session) {
  const fetch = await initializeHyperSDK(options);

  return async function protocolHandler(req, callback) {
    const { url, method = 'GET', headers = {}, uploadData } = req;

    try {
      console.log(`Handling request: ${method} ${url}`);
      console.log('Headers:', headers);

      const body = uploadData ? Readable.from(readBody(uploadData, session)) : null

      const response = await fetch(url, {
        method,
        headers,
        body,
        duplex: 'half'
      });

      // Use a stream to handle the response data
      if (response.body) {
        const responseBody = Readable.from(response.body);
        console.log('Response received:', response.status);

        callback({
          statusCode: response.status,
          headers: Object.fromEntries(response.headers),
          data: responseBody // Return the stream directly
        });
      } else {
        console.warn('No response body received.');
        callback({
          statusCode: response.status,
          headers: Object.fromEntries(response.headers),
          data: Readable.from('') // Return empty data if no body
        });
      }
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
