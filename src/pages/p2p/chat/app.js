// src/pages/app.js

// Define the base URL for the chat API using the hyper protocol
const apiBase = 'hyper://chat';

// Function to create a new chat room
async function createChatRoom() {
    try {
        const response = await fetch(`${apiBase}?action=create`, { method: 'POST' });
        if (!response.ok) {
            throw new Error(`Failed to create chat room: ${response.statusText}`);
        }
        const data = await response.json();
        const { roomKey } = data;
        console.log(`Chat room created with key: ${roomKey}`);

        await joinChatRoom(roomKey);
        startChatRoom(roomKey);
    } catch (error) {
        console.error('Error creating chat room:', error);
        alert(`Error creating chat room: ${error.message}`);
    }
}

// Function to join an existing chat room
async function joinChatRoom(roomKey) {
    try {
        const response = await fetch(`${apiBase}?action=join&roomKey=${roomKey}`, {
            method: 'POST',
        });
        if (!response.ok) {
            throw new Error(`Failed to join chat room: ${response.statusText}`);
        }
        const data = await response.json();
        console.log(data.message);
    } catch (error) {
        console.error('Error joining chat room:', error);
        alert(`Error joining chat room: ${error.message}`);
        throw error;
    }
}

document.querySelector('#create-chat-room').addEventListener('click', async () => {
    await createChatRoom();
});

document.querySelector('#join-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const topic = document.querySelector('#join-chat-room-topic').value.trim();
    if (!topic) {
        alert('Please enter a valid chat room topic.');
        return;
    }
    try {
        await joinChatRoom(topic);
        startChatRoom(topic);
    } catch (error) {}
});

function startChatRoom(roomKey) {
    document.querySelector('#setup').style.display = 'none';
    document.querySelector('#chat').style.display = 'flex';
    document.querySelector('#chat-room-info').style.display = 'flex'; // Show room info
    document.querySelector('#chat-room-topic').textContent = roomKey;
    setupMessageReceiver();
}

document.querySelector('#message-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const messageInput = document.querySelector('#message');
    const message = messageInput.value.trim();
    if (!message) {
        alert('Cannot send an empty message.');
        return;
    }
    messageInput.value = '';
    sendMessage('You', message);
});

async function sendMessage(sender, message) {
    try {
        onMessageReceived(sender, message);
        const response = await fetch(`${apiBase}?action=send`, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: message,
        });
        if (!response.ok) {
            throw new Error(`Failed to send message: ${response.statusText}`);
        }
        const data = await response.json();
        console.log(data.message);
    } catch (error) {
        console.error('Error sending message:', error);
        alert(`Error sending message: ${error.message}`);
    }
}

function setupMessageReceiver() {
    const eventSource = new EventSource(`${apiBase}?action=receive`);

    eventSource.onmessage = function (event) {
        const messageData = JSON.parse(event.data);
        const sender = messageData.sender;
        const message = messageData.message;
        onMessageReceived(sender, message);
    };

    eventSource.addEventListener('peersCount', function (event) {
        const count = event.data;
        updatePeersCount(count);
    });

    eventSource.onerror = function (error) {
        console.error('EventSource failed:', error);
        alert('Connection to the message stream failed.');
    };
}

function onMessageReceived(sender, message) {
    const messagesContainer = document.querySelector('#messages');
    const messageDiv = document.createElement('div');
    const messageTextDiv = document.createElement('div');
    const senderAndTimeDiv = document.createElement('div'); // Sender and time in one line

    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    messageDiv.classList.add('message');
    messageTextDiv.innerHTML = formatMessageWithLinks(message); // Format message to include links
    senderAndTimeDiv.textContent = `${sender} · ${time}`; // Combine sender and timestamp

    if (sender === 'You') {
        messageDiv.classList.add('message-right'); // Align to the right
        messageTextDiv.classList.add('message-text-right');
        senderAndTimeDiv.classList.add('sender-right'); // Right-align sender and time
    } else {
        messageDiv.classList.add('message-left'); // Align to the left
        messageTextDiv.classList.add('message-text-left');
        senderAndTimeDiv.classList.add('sender-left'); // Left-align sender and time
    }

    messageDiv.appendChild(messageTextDiv);
    messageDiv.appendChild(senderAndTimeDiv);

    messagesContainer.appendChild(messageDiv);
    messagesContainer.scrollTop = messagesContainer.scrollHeight; // Scroll to the bottom
}

/**
 * Helper function to find URLs in the message and convert them to anchor tags
 * with target="_blank" and rel="noopener noreferrer"
 */
function formatMessageWithLinks(message) {
    const urlPattern = /(\b(https?|ftp|file|hyper|ipfs|ipns):\/\/[-A-Z0-9+&@#\/%?=~_|!:,.;]*[-A-Z0-9+&@#\/%=~_|])/gi;
    return message.replace(urlPattern, function(url) {
        return `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;
    });
}

function updatePeersCount(count) {
    document.querySelector('#peers-count').textContent = count;
}