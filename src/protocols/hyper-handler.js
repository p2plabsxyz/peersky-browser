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

// Helper function to read and handle body data, especially for 'PUT' and 'POST'
async function readBody(bodyStream) {
  if (!bodyStream) return null;

  const reader = bodyStream.getReader();
  const chunks = [];
  let readResult;

  try {
    while (!(readResult = await reader.read()).done) {
      chunks.push(readResult.value);
    }
  } catch (error) {
    console.error('Error reading body:', error);
    throw error;
  }

  // Return a readable stream instead of a single buffer
  return Readable.from(chunks);
}

// Create the Hyper protocol handler
export async function createHandler(options, session) {
  const fetch = await initializeHyperSDK(options);

  return async function protocolHandler(req, callback) {
    const { url, method = 'GET', headers = {}, body = null } = req;

    try {
      console.log(`Handling request: ${method} ${url}`);
      console.log('Headers:', headers);

      // Check if the request contains multipart/form-data
      const contentType = headers['Content-Type'] || headers['content-type'] || '';
      const isMultipart = contentType.includes('multipart/form-data');

      let bodyContent;
      if (method !== 'GET') {
        if (isMultipart) {
          // Handle multipart form-data
          const files = await handleMultipartFormData(req);
          bodyContent = files.length > 0 ? files[0].stream : null;
          console.log(`Parsed ${files.length} files from form data.`);
        } else {
          // Handle regular body data
          bodyContent = await readBody(body);
          console.log('Body content read for non-multipart request.');
        }
      }

      const response = await fetch(url, {
        method,
        headers,
        body: bodyContent
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
