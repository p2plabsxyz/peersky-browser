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

// Function to handle multipart form-data
async function handleMultipartFormData(request) {
  try {
    const formData = await request.formData();
    const files = [];

    for (const [name, data] of formData.entries()) {
      if (name === 'file') {
        files.push({ name: data.name, stream: data.stream() });
      }
    }

    return files;
  } catch (error) {
    console.error('Error handling form data:', error);
    throw error;
  }
}


async function * readBody (body) {
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

      // Check if the request contains multipart/form-data
      const contentType = headers['Content-Type'] || headers['content-type'] || '';
      const isMultipart = contentType.includes('multipart/form-data');

      const body = uploadData ? Readable.from(readBody(uploadData)) : null

      const response = await fetch(url, {
        method,
        headers,
        body
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
