const API = "hyper://chat";

function chatUrl(action, roomKey) {
  return roomKey ? `${API}?action=${action}&roomKey=${roomKey}` : `${API}?action=${action}`;
}

async function apiRequest(action, opts = {}) {
  const qs = opts.roomKey ? `?action=${action}&roomKey=${opts.roomKey}` : `?action=${action}`;
  const init = {};
  if (opts.body) {
    init.method = "POST";
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(opts.body);
  } else if (opts.post) {
    init.method = "POST";
  }
  const res = await fetch(`${API}${qs}`, init);
  if (!res.ok) throw new Error(`${action}: ${res.statusText}`);
  return res.json();
}

export const chat = {
  receiveAllUrl: () => chatUrl("receive-all"),
  getProfile: () => apiRequest("get-profile"),
  getRooms: () => apiRequest("get-rooms"),
  saveProfile: (body) => apiRequest("save-profile", { body }),
  createRoom: (body) => apiRequest("create-key", { body }),
  joinRoom: (roomKey) => apiRequest("join", { roomKey, post: true }),
  getHistory: (roomKey) => apiRequest("get-history", { roomKey }),
  setActive: (roomKey) => apiRequest("set-active", { roomKey, post: true }),
  markRead: (roomKey) => apiRequest("mark-read", { roomKey, post: true }),
  sendMessage: (roomKey, body) => apiRequest("send", { roomKey, body }),
  react: (roomKey, body) => apiRequest("react", { roomKey, body }),
  joinDM: (body) => apiRequest("join-dm", { body }),
  acceptDM: (body) => apiRequest("accept-dm", { body }),
  rejectDM: (body) => apiRequest("reject-dm", { body }),
  updateRoom: (roomKey, body) => apiRequest("update-room", { roomKey, body }),
  deleteRoom: (roomKey) => apiRequest("delete-room", { roomKey, post: true }),
};
