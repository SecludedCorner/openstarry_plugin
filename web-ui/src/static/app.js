/**
 * OpenStarry Web UI — WebSocket client for browser-based agent interaction.
 */
(function () {
  "use strict";

  const config = window.__OPENSTARRY_CONFIG__ || {
    websocketUrl: "ws://localhost:8080/ws",
    title: "OpenStarry Agent",
  };

  const MAX_MESSAGES = 500;

  // DOM references
  const titleEl = document.getElementById("title");
  const statusEl = document.getElementById("status");
  const messagesEl = document.getElementById("messages");
  const inputEl = document.getElementById("input");
  const sendBtn = document.getElementById("send-btn");

  // State
  let ws = null;
  let sessionId = localStorage.getItem("openstarry_session_id");
  let reconnectDelay = 1000;
  let reconnectTimer = null;
  let messageCount = 0;

  // Set page title
  if (titleEl) titleEl.textContent = config.title;
  document.title = config.title;

  function formatTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString();
  }

  function addMessage(text, type, timestamp) {
    const div = document.createElement("div");
    div.className = "message " + type;

    const textNode = document.createElement("span");
    textNode.textContent = text;
    div.appendChild(textNode);

    if (timestamp) {
      const ts = document.createElement("span");
      ts.className = "timestamp";
      ts.textContent = formatTime(timestamp);
      div.appendChild(ts);
    }

    messagesEl.appendChild(div);
    messageCount++;

    // Trim old messages to prevent memory leaks
    while (messageCount > MAX_MESSAGES && messagesEl.firstChild) {
      messagesEl.removeChild(messagesEl.firstChild);
      messageCount--;
    }

    // Auto-scroll to bottom
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function setStatus(state) {
    statusEl.className = state;
    if (state === "connected") {
      statusEl.textContent = "Connected";
      inputEl.disabled = false;
      sendBtn.disabled = false;
    } else if (state === "reconnecting") {
      statusEl.textContent = "Reconnecting...";
      inputEl.disabled = true;
      sendBtn.disabled = true;
    } else {
      statusEl.textContent = "Disconnected";
      inputEl.disabled = true;
      sendBtn.disabled = true;
    }
  }

  function extractText(payload) {
    // payload.message is a Message object: { content: ContentSegment[] }
    var msg = payload.message;
    if (msg && Array.isArray(msg.content)) {
      var parts = [];
      for (var i = 0; i < msg.content.length; i++) {
        var seg = msg.content[i];
        if (seg.type === "text" && seg.text) {
          parts.push(seg.text);
        } else if (seg.type === "tool_call" && seg.toolCall) {
          parts.push("[tool] " + (seg.toolCall.name || "unknown"));
        } else if (seg.type === "tool_result" && seg.toolResult) {
          parts.push("[result] " + (typeof seg.toolResult.output === "string" ? seg.toolResult.output : JSON.stringify(seg.toolResult.output)));
        }
      }
      if (parts.length > 0) return parts.join("\n");
    }
    // Fallback: try common string fields
    if (typeof payload.content === "string") return payload.content;
    if (typeof payload.text === "string") return payload.text;
    if (typeof msg === "string") return msg;
    return JSON.stringify(payload);
  }

  function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    let url = config.websocketUrl;
    // Append token from URL hash if present (e.g., #token=xxx)
    const hash = window.location.hash.substring(1);
    if (hash.startsWith("token=")) {
      const token = hash.substring(6);
      url += (url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token);
    }

    try {
      ws = new WebSocket(url);
    } catch (err) {
      addMessage("Failed to create WebSocket connection", "system", Date.now());
      scheduleReconnect();
      return;
    }

    ws.onopen = function () {
      setStatus("connected");
      reconnectDelay = 1000;

      // Resume session if we have one
      if (sessionId) {
        ws.send(JSON.stringify({
          type: "session_resume",
          sessionId: sessionId,
        }));
      }

      addMessage("Connected to agent", "system", Date.now());
    };

    ws.onmessage = function (event) {
      try {
        var msg = JSON.parse(event.data);
      } catch (e) {
        return;
      }

      if (msg.type === "connected") {
        // Store session ID for reconnection
        if (msg.sessionId) {
          sessionId = msg.sessionId;
          localStorage.setItem("openstarry_session_id", sessionId);
        }
      } else if (msg.type === "agent_event" && msg.event) {
        var evt = msg.event;
        var eventType = evt.type || "";
        var payload = evt.payload || {};

        if (eventType === "message:assistant" || eventType === "MESSAGE_ASSISTANT") {
          var text = extractText(payload);
          if (text) addMessage(text, "agent", evt.timestamp);
        } else if (eventType === "loop:started" || eventType === "LOOP_STARTED") {
          // Processing indicator — skip
        } else if (eventType === "loop:finished" || eventType === "LOOP_FINISHED") {
          // Processing done — skip
        } else if (eventType === "error" || eventType === "AGENT_ERROR") {
          var errMsg = typeof payload.message === "string" ? payload.message : JSON.stringify(payload);
          addMessage("Error: " + errMsg, "system", evt.timestamp);
        }
      } else if (msg.type === "error") {
        addMessage("Server error: " + (msg.error || "unknown"), "system", Date.now());
      }
    };

    ws.onclose = function () {
      setStatus("disconnected");
      ws = null;
      scheduleReconnect();
    };

    ws.onerror = function () {
      // onclose will fire after this
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    setStatus("reconnecting");
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
      connect();
    }, reconnectDelay);
  }

  function sendMessage() {
    var text = inputEl.value.trim();
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;

    ws.send(JSON.stringify({
      type: "user_input",
      sessionId: sessionId,
      payload: { text: text },
    }));

    addMessage(text, "user", Date.now());
    inputEl.value = "";
    inputEl.focus();
  }

  // Event listeners
  sendBtn.addEventListener("click", sendMessage);
  inputEl.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Start connection
  connect();
})();
