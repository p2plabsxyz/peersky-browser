import { Client } from 'web3protocol';
import { getDefaultChainList } from 'web3protocol/chains';

async function initializeWeb3Client() {
  // Get the default chain list
  let chainList = getDefaultChainList();

  // Initialize the web3 client with the chain list
  let web3Client = new Client(chainList);

  return web3Client;
}

export async function createHandler() {
  const web3Client = await initializeWeb3Client();

  return async function protocolHandler(request) {
    const { url } = request;

    try {
      const fetchedWeb3Url = await web3Client.fetchUrl(url);
      return new Response(fetchedWeb3Url.output, {
        status: fetchedWeb3Url.httpCode,
        headers: fetchedWeb3Url.httpHeaders,
      });
    } catch (error) {
      console.error('Error fetching with Web3 protocol:', error);

      const errorResponse = `Error fetching with Web3 protocol: ${error.message}\n` +
        `RPC URLs: ${error.rpcUrls?.join(', ')}\n` +
        `RPC URLs Errors: ${error.rpcUrlsErrors?.join(', ')}`;

      return new Response(errorResponse, {
        status: 500,
        headers: { 'Content-Type': 'text/plain' },
      });
    }
  };
}
