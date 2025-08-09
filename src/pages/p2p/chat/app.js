const apiBase = "hyper://chat";
let offlineMessages = [];
const displayedMessages = {};
let currentEventSource = null;

// Utility function to format timestamps
function formatTimestamp(ts) {
  const now = new Date();
  const date = new Date(ts);
  const diffMs = now - date;
  const diffDays = diffMs / (1000 * 60 * 60 * 24);

  if (diffDays > 30) {
    const ds = date.toLocaleDateString([], {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const tsStr = date.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    return `${ds} ${tsStr}`;
  } else {
    const sec = Math.floor(diffMs / 1000);
    const min = Math.floor(sec / 60);
    const hrs = Math.floor(min / 60);
    const day = Math.floor(hrs / 24);
    const wk = Math.floor(day / 7);
    const mon = Math.floor(day / 30);

    if (sec < 60) return `${sec} sec${sec !== 1 ? "s" : ""} ago`;
    if (min < 60) return `${min} min${min !== 1 ? "s" : ""} ago`;
    if (hrs < 24) return `${hrs} hr${hrs !== 1 ? "s" : ""} ago`;
    if (day < 7) return `${day} d${day !== 1 ? "s" : ""} ago`;
    if (wk < 4) return `${wk} w${wk !== 1 ? "s" : ""} ago`;
    return `${mon} mo${mon !== 1 ? "s" : ""} ago`;
  }
}

// Create a new chat room and then join it
async function createChatRoom() {
  try {
    const response = await fetch(`${apiBase}?action=create-key`, {
      method: "POST",
    });
    if (!response.ok) {
      throw new Error(`Failed to create chat room: ${response.statusText}`);
    }
    const data = await response.json();
    const { roomKey } = data;
    console.log(`Chat room created with key: ${roomKey}`);

    await joinChatRoom(roomKey);
    startChatRoom(roomKey);
  } catch (error) {
    console.error("Error creating chat room:", error);
    alert(`Error creating chat room: ${error.message}`);
  }
}

// Join an existing chat room using its key
async function joinChatRoom(roomKey) {
  try {
    const response = await fetch(`${apiBase}?action=join&roomKey=${roomKey}`, {
      method: "POST",
    });
    if (!response.ok) {
      throw new Error(`Failed to join chat room: ${response.statusText}`);
    }
    const data = await response.json();
    console.log(data.message);
  } catch (error) {
    console.error("Error joining chat room:", error);
    alert(`Error joining chat room: ${error.message}`);
    throw error;
  }
}

// Start chat room UI and setup message receiver with the given roomKey
function startChatRoom(roomKey) {
  document.querySelector("#setup").style.display = "none";
  document.querySelector("#chat").style.display = "flex";
  document.querySelector("#chat-room-info").style.display = "flex";
  document.querySelector("#chat-room-topic").textContent = roomKey;
  setupMessageReceiver(roomKey);
}

// Event listeners for creating and joining chat rooms
document
  .querySelector("#create-chat-room")
  .addEventListener("click", async () => {
    await createChatRoom();
  });

document.querySelector("#join-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const topic = document.querySelector("#join-chat-room-topic").value.trim();
  // Validate room key format: 64-character hexadecimal string
  const roomKeyPattern = /^[a-f0-9]{64}$/i;
  if (!roomKeyPattern.test(topic)) {
    alert("Invalid room key! Please enter a valid 64-character hexadecimal key.");
    return;
  }
  try {
    await joinChatRoom(topic);
    startChatRoom(topic);
  } catch (error) {
    // Error already handled in joinChatRoom
  }
});

// Event listener for sending a chat message
document
  .querySelector("#message-form")
  .addEventListener("submit", async (e) => {
    e.preventDefault();
    const messageInput = document.querySelector("#message");
    const message = messageInput.value.trim();
    if (!message) {
      alert("Cannot send an empty message.");
      return;
    }
    messageInput.value = "";
    sendMessage("You", message);
  });

// Function to send a message
async function sendMessage(sender, message) {
  const roomKey = document.querySelector("#chat-room-topic").textContent;
  if (navigator.onLine) {
    try {
      await postMessage(sender, message, roomKey);
    } catch (e) {
      console.error("Error sending message:", e);
      alert(e.message);
    }
  } else {
    offlineMessages.push({ sender, message });
    alert("Offline message stored.");
  }
}

// Function to post a message to the backend
async function postMessage(sender, message, roomKey) {
  const url = `${apiBase}?action=send&roomKey=${roomKey}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sender, message }),
  });
  if (!resp.ok) {
    throw new Error(`Failed to send message: ${resp.statusText}`);
  }
}

// Setup the message receiver using SSE for a particular room
function setupMessageReceiver(roomKey) {
  // Close any previous EventSource connection
  if (currentEventSource) {
    currentEventSource.close();
  }
  const es = new EventSource(`${apiBase}?action=receive&roomKey=${roomKey}`);
  currentEventSource = es;

  es.onmessage = (ev) => {
    const { sender, message, timestamp } = JSON.parse(ev.data);
    onMessageReceived(sender, message, timestamp, roomKey);
  };

  es.addEventListener("peersCount", (ev) => {
    updatePeersCount(ev.data);
  });

  es.onerror = () => {
    console.error("EventSource error");
    alert("SSE stream failed.");
  };

  // When coming back online, synchronize offline messages
  window.addEventListener("online", () => syncOfflineMessages(roomKey));
}

// Sync any messages stored while offline when the connection is restored
async function syncOfflineMessages(roomKey) {
  if (offlineMessages.length > 0) {
    for (const { sender, message } of offlineMessages) {
      try {
        await postMessage(sender, message, roomKey);
        onMessageReceived(sender, message, Date.now(), roomKey);
      } catch (e) {
        console.error("Error syncing offline message:", e);
      }
    }
    offlineMessages = [];
  }
}

// Add the received message to the chat window
function onMessageReceived(sender, message, timestamp, roomKey) {
  // Avoid displaying duplicate messages
  if (!displayedMessages[roomKey]) displayedMessages[roomKey] = new Set();
  const msgID = `${sender}-${timestamp}-${message}`;
  if (displayedMessages[roomKey].has(msgID)) return;
  displayedMessages[roomKey].add(msgID);

  const container = document.querySelector("#messages");
  const msgDiv = document.createElement("div");
  const textDiv = document.createElement("div");
  const metaDiv = document.createElement("div");

  const dispTime = formatTimestamp(timestamp);

  msgDiv.classList.add("message");
  textDiv.innerHTML = formatMessageWithLinks(message);
  metaDiv.textContent = `${sender} · ${dispTime}`;

  // Style messages according to the sender
  if (sender === "You") {
    msgDiv.classList.add("message-right");
    textDiv.classList.add("message-text-right");
    metaDiv.classList.add("sender-right");
  } else {
    msgDiv.classList.add("message-left");
    textDiv.classList.add("message-text-left");
    metaDiv.classList.add("sender-left");
  }
  msgDiv.appendChild(textDiv);
  msgDiv.appendChild(metaDiv);

  container.appendChild(msgDiv);
  container.scrollTop = container.scrollHeight;
}

// Convert detected URLs in the message into clickable links
// TODO: Add XSS protection by escaping HTML content before processing URLs
function formatMessageWithLinks(msg) {
  const pattern = /(\b(https?|ftp|file|hyper|ipfs|ipns):\/\/\S+)/gi;
  return msg.replace(pattern, (url) => {
    const isCustom = /^(hyper|ipfs|ipns):\/\//i.test(url);
    if (isCustom) {
      return `<a href="${url}" data-custom="true">${url}</a>`;
    }
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;
  });
}

// Open custom protocol links (hyper://, ipfs://, ipns://) externally via Electron
document.addEventListener("click", (ev) => {
  const t = ev.target;
  if (t.tagName === "A") {
    const href = t.getAttribute("href");
    if (
      href.startsWith("hyper://") ||
      href.startsWith("ipfs://") ||
      href.startsWith("ipns://")
    ) {
      ev.preventDefault();
      const { shell } = require("electron");
      shell.openExternal(href);
    }
  }
});

// Update the displayed peer count in the UI
function updatePeersCount(count) {
  document.querySelector("#peers-count").textContent = count;
}
