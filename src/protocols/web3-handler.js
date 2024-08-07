import { Client } from 'web3protocol';
import { getDefaultChainList } from 'web3protocol/chains';
import { Readable } from 'stream';

async function initializeWeb3Client() {
  // Get the default chain list
  let chainList = getDefaultChainList();

  // Initialize the web3 client with the chain list
  let web3Client = new Client(chainList);

  return web3Client;
}

export async function createHandler() {
  const web3Client = await initializeWeb3Client();

  return async function protocolHandler(request, callback) {
    const { url } = request;

    try {
      const fetchedWeb3Url = await web3Client.fetchUrl(url);

      // Collect the response data
      const chunks = [];
      const reader = fetchedWeb3Url.output.getReader();
      let readResult;
      while (!(readResult = await reader.read()).done) {
        chunks.push(readResult.value);
      }
      const data = Buffer.concat(chunks);

      // Send response back to the browser
      callback({
        statusCode: fetchedWeb3Url.httpCode,
        headers: fetchedWeb3Url.httpHeaders,
        data: Readable.from(data)
      });
    } catch (error) {
      console.error('Error fetching with Web3 protocol:', error);

      const errorResponse = `Error fetching with Web3 protocol: ${error.message}\n` +
        `RPC URLs: ${error.rpcUrls?.join(', ')}\n` +
        `RPC URLs Errors: ${error.rpcUrlsErrors?.join(', ')}`;

      callback({
        statusCode: 500,
        headers: { 'Content-Type': 'text/plain' },
        data: Readable.from(errorResponse)
      });
    }
  };
}
