import { create as createSDK } from 'hyper-sdk';
import makeHyperFetch from 'hypercore-fetch';
import { Readable, PassThrough } from 'stream';
import fs from 'fs-extra';
import Hyperswarm from 'hyperswarm';
import crypto from 'hypercore-crypto';
import b4a from 'b4a';

let sdk, fetch;
let swarm = null;
let peers = [];

// Store all active SSE client streams
let sseClients = [];

// Initialize the SDK and fetch
async function initializeHyperSDK(options) {
  if (sdk && fetch) return fetch; // Return fetch if already initialized

  console.log('Initializing Hyper SDK...');
  sdk = await createSDK(options); // Create SDK
  fetch = makeHyperFetch({
    sdk: sdk,
    writable: true, // Enable write capability
  });
  console.log('Hyper SDK initialized.');
  return fetch; // Return the fetch function
}

// Protocol handler creation
export async function createHandler(options, session) {
  await initializeHyperSDK(options); // Initialize SDK and fetch

  return async function protocolHandler(req, callback) {
    const { url, method = 'GET', headers = {}, uploadData } = req;
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const protocol = urlObj.protocol.replace(':', '');

    console.log(`Handling request: ${method} ${url}`);

    try {
      if (protocol === 'hyper' && (urlObj.hostname === 'chat' || pathname.startsWith('/chat'))) {
        await handleChatRequest(req, callback, session); // Handle chat-specific requests
      } else {
        await handleHyperRequest(req, callback, session); // Handle general hyper requests
      }
    } catch (e) {
      console.error('Failed to handle Hyper request:', e);
      callback({
        statusCode: 500,
        headers: { 'Content-Type': 'text/plain' },
        data: Readable.from([`Error handling Hyper request: ${e.message}`]),
      });
    }
  };
}

// Function to handle chat requests
async function handleChatRequest(req, callback, session) {
  const { url, method, uploadData } = req; // Extract uploadData
  const urlObj = new URL(url);
  const searchParams = urlObj.searchParams;
  const action = searchParams.get('action');

  console.log(`Chat request: ${method} ${url}`);

  try {
    if (method === 'POST' && action === 'create') {
      const roomKey = await generateChatRoom();
      console.log(`Created chat room with key: ${roomKey}`);
      // Do NOT automatically join the created chat room on the server
      callback({
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        data: Readable.from([Buffer.from(JSON.stringify({ roomKey }))]),
      });
    } else if (method === 'POST' && action === 'join') {
      const roomKey = searchParams.get('roomKey');
      if (!roomKey) {
        throw new Error('Missing roomKey in join request');
      }
      console.log(`Joining chat room with key: ${roomKey}`);
      await joinChatRoom(roomKey);
      callback({
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        data: Readable.from([Buffer.from(JSON.stringify({ message: 'Joined chat room' }))]),
      });
    } else if (method === 'POST' && action === 'send') {
      const message = await getRequestBody(uploadData, session); // Corrected
      console.log(`Sending message: ${message}`);
      sendMessageToPeers(message);
      callback({
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        data: Readable.from([Buffer.from(JSON.stringify({ message: 'Message sent' }))]),
      });
    } else if (method === 'GET' && action === 'receive') {
      console.log('Setting up message stream for receiving messages');
      const stream = new PassThrough();

      // Keep a reference to the stream to prevent garbage collection
      session.messageStream = stream;

      // Send keep-alive messages every 15 seconds
      const keepAliveInterval = setInterval(() => {
        stream.write(':\n\n'); // Comment line in SSE to keep the connection alive
      }, 15000);

      // Clean up on stream close
      stream.on('close', () => {
        clearInterval(keepAliveInterval);
        sseClients = sseClients.filter(s => s !== stream);
      });

      // Add the stream to the list of SSE clients
      sseClients.push(stream);

      callback({
        statusCode: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
        data: stream,
      });
    } else {
      callback({
        statusCode: 400,
        headers: { 'Content-Type': 'text/plain' },
        data: Readable.from([Buffer.from('Invalid chat action')]),
      });
    }
  } catch (e) {
    console.error('Error in handleChatRequest:', e);
    callback({
      statusCode: 500,
      headers: { 'Content-Type': 'text/plain' },
      data: Readable.from([Buffer.from(`Error in chat request: ${e.message}`)]),
    });
  }
}

// Function to handle general Hyper requests
async function handleHyperRequest(req, callback, session) {
  const { url, method = 'GET', headers = {}, uploadData } = req;
  const fetch = await initializeHyperSDK(); // Ensure fetch is initialized

  let body = null;
  if (uploadData) {
    try {
      const buffer = await readBody(uploadData, session);
      body = Readable.from([buffer]); // Pass buffer within an array
    } catch (error) {
      console.error('Error reading uploadData:', error);
      callback({
        statusCode: 400,
        headers: { 'Content-Type': 'text/plain' },
        data: Readable.from([Buffer.from('Invalid upload data')]),
      });
      return;
    }
  }

  try {
    const response = await fetch(url, {
      method,
      headers,
      body,
      duplex: 'half', // Support half-duplex communication
    });

    if (response.body) {
      // Determine if the response is binary or text based on Content-Type
      const contentType = response.headers.get('Content-Type') || '';
      let responseData;

      if (contentType.startsWith('text/') || contentType.includes('application/json')) {
        // For text or JSON responses
        const text = await response.text();
        responseData = Buffer.from(text);
      } else {
        // For binary responses (e.g., images)
        const arrayBuffer = await response.arrayBuffer();
        responseData = Buffer.from(arrayBuffer);
      }

      const responseBody = Readable.from([responseData]);
      console.log('Response received:', response.status);

      callback({
        statusCode: response.status,
        headers: Object.fromEntries(response.headers),
        data: responseBody,
      });
    } else {
      console.warn('No response body received.');
      callback({
        statusCode: response.status,
        headers: Object.fromEntries(response.headers),
        data: Readable.from([Buffer.from('')]),
      });
    }
  } catch (e) {
    console.error('Failed to fetch from Hyper SDK:', e);
    callback({
      statusCode: 500,
      headers: { 'Content-Type': 'text/plain' },
      data: Readable.from([Buffer.from(`Error fetching data: ${e.message}`)]),
    });
  }
}

// Helper function to read request body
async function readBody(body, session) {
  const buffers = [];
  for (const data of body || []) {
    if (data.bytes) {
      buffers.push(data.bytes);
    } else if (data.file) {
      const fileBuffer = await fs.promises.readFile(data.file);
      buffers.push(fileBuffer);
    } else if (data.blobUUID) {
      const blobData = await session.getBlobData(data.blobUUID);
      buffers.push(blobData);
    }
  }
  return Buffer.concat(buffers);
}

// Helper function to extract request body
async function getRequestBody(uploadData, session) {
  try {
    const buffer = await readBody(uploadData, session);
    console.log('Request body received:', buffer.toString());
    return buffer.toString();
  } catch (error) {
    console.error('Error reading request body:', error);
    throw error;
  }
}

// Chat room generation and swarm management functions
async function generateChatRoom() {
  const topicBuffer = crypto.randomBytes(32);
  const roomKey = b4a.toString(topicBuffer, 'hex');
  // Do NOT join the swarm here; let the client handle joining
  return roomKey;
}

async function joinChatRoom(roomKey) {
  const topicBuffer = b4a.from(roomKey, 'hex');
  await joinSwarm(topicBuffer);
}

async function joinSwarm(topicBuffer) {
  if (swarm) {
    console.log('Already connected to a swarm. Destroying current swarm.');
    swarm.destroy();
    peers = [];
  }

  swarm = new Hyperswarm();

  swarm.on('connection', (peer) => {
    console.log('New peer connected');
    peers.push(peer);
  
    // Notify clients of updated peer count
    updatePeersCount();
  
    const peerId = b4a.toString(peer.remotePublicKey, 'hex').substr(0, 6); // Get peer ID
  
    peer.on('data', (data) => {
      const message = data.toString();
      console.log(`Received message from peer (${peerId}): ${message}`);
      // Broadcast the message along with the sender (peer) ID to all SSE clients
      sseClients.forEach(stream => {
        stream.write(`data: ${JSON.stringify({ sender: peerId, message })}\n\n`);
      });
    });
  
    peer.on('close', () => {
      console.log('Peer disconnected');
      peers = peers.filter((p) => p !== peer);
      // Notify clients of updated peer count
      updatePeersCount();
    });
  });

  const discovery = swarm.join(topicBuffer, { client: true, server: true });
  await discovery.flushed();
  console.log('Joined swarm with topic:', b4a.toString(topicBuffer, 'hex'));
}

// Send message to all connected peers
function sendMessageToPeers(message) {
  console.log(`Broadcasting message to ${peers.length} peers`);
  peers.forEach((peer) => {
    peer.write(message);
  });
}

// Update peers count and notify clients
function updatePeersCount() {
  const count = peers.length;
  console.log(`Peers connected: ${count}`);
  // Broadcast the updated peer count to all SSE clients
  sseClients.forEach(stream => {
    stream.write(`event: peersCount\ndata: ${count}\n\n`);
  });
}
