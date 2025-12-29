# Agent Arena UI Rewrite Plan

## Problem Summary
The current HTMX + WebSocket + vanilla JS architecture has fundamental issues:
- **3 conflicting state sources**: HTMX partials, WebSocket events, JS globals
- **Race conditions**: Multiple update paths for same data
- **Inconsistent patterns**: Some forms use HTMX, others JS, some both
- **No error boundaries**: Failed requests leave UI in broken state

## Recommendation: Vanilla JS Single-Page App

### Why Vanilla JS?

| Approach | Build Step | Dependencies | Learning Curve | Maintenance |
|----------|-----------|--------------|----------------|-------------|
| React/Vue | Required | Many | High | Medium-High |
| Svelte | Required | Few | Medium | Low-Medium |
| Alpine.js | None | 1 (15KB) | Low | Low |
| **Vanilla JS** | **None** | **Zero** | **None** | **Very Low** |

Modern browsers provide everything needed:
- `fetch()` for API calls
- `WebSocket` for real-time
- ES Modules for code organization
- Template literals for HTML
- CSS Custom Properties for theming
- `Proxy` for reactive state (optional)

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      index.html                              │
│  ┌─────────────────────────────────────────────────────────┐│
│  │                     <script type="module">              ││
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────┐ ││
│  │  │  State   │→→│  API     │→→│  WS      │→→│ Render  │ ││
│  │  │  Store   │  │  Client  │  │  Client  │  │ Engine  │ ││
│  │  └──────────┘  └──────────┘  └──────────┘  └─────────┘ ││
│  └─────────────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────────────┐│
│  │                     <style>                             ││
│  │           Tailwind CDN or Custom CSS                    ││
│  └─────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

### Core Modules (in single file or ES modules)

#### 1. State Store (~50 lines)
```javascript
const state = {
  room: 'general',
  rooms: [],
  messages: [],
  agents: [],
  typing: new Set(),
  status: { running: false, mode: 'hybrid', maxTurns: 20 },
  project: null,
  senderName: localStorage.getItem('senderName') || 'Human'
};

const listeners = new Set();
function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function update(changes) { Object.assign(state, changes); listeners.forEach(fn => fn(state)); }
```

#### 2. API Client (~80 lines)
```javascript
const api = {
  async getMessages(room, limit = 50) {
    const res = await fetch(`/api/messages?room=${room}&limit=${limit}`);
    return res.json();
  },
  async sendMessage(room, content, senderName, files = []) {
    const form = new FormData();
    form.append('room', room);
    form.append('message', content);
    form.append('sender', senderName);
    files.forEach(f => form.append('files', f));
    return fetch('/send', { method: 'POST', body: form });
  },
  async setMode(mode) { ... },
  async start(mode, maxTurns) { ... },
  async stop() { ... },
  async stepAgent(agentId, room) { ... },
  // ... other endpoints
};
```

#### 3. WebSocket Client (~60 lines)
```javascript
let ws;
function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => ws.send(JSON.stringify({ type: 'join_room', roomId: state.room }));
  ws.onmessage = (e) => {
    const data = JSON.parse(e.data);
    handleEvent(data);
  };
  ws.onclose = () => setTimeout(connect, 2000); // Auto-reconnect
}

function handleEvent(data) {
  switch (data.type) {
    case 'message_added':
      update({ messages: [...state.messages, data.message] });
      break;
    case 'agent_typing':
      const typing = new Set(state.typing);
      data.isTyping ? typing.add(data.agentName) : typing.delete(data.agentName);
      update({ typing });
      break;
    // ... other events
  }
}
```

#### 4. Render Engine (~150 lines)
```javascript
function render() {
  document.getElementById('app').innerHTML = `
    <div class="layout">
      ${renderSidebar()}
      ${renderMain()}
    </div>
  `;
  attachEventListeners();
}

function renderMessages() {
  return state.messages.map(m => `
    <div class="message ${m.senderName === 'Human' ? 'human' : 'agent'}">
      <div class="avatar">${m.senderName[0]}</div>
      <div class="content">
        <div class="sender">${m.senderName}</div>
        <div class="text">${marked(m.content)}</div>
      </div>
    </div>
  `).join('');
}

// Efficient DOM updates - only re-render changed sections
function updateMessages() {
  document.getElementById('messages').innerHTML = renderMessages();
  scrollToBottom();
}

subscribe((state) => {
  // Selective updates based on what changed
  updateMessages();
  updateAgentList();
  updateTypingIndicator();
});
```

### File Structure Options

#### Option A: Single File (Simplest)
```
public/
  index.html        # Everything: HTML + CSS + JS (~800 lines)
```

#### Option B: Minimal Split (Recommended)
```
public/
  index.html        # HTML shell + imports
  app.js            # State, API, WebSocket, Render
  style.css         # All styles (or Tailwind CDN)
```

#### Option C: ES Modules (Cleanest)
```
public/
  index.html        # HTML shell
  js/
    main.js         # Entry point
    state.js        # State store
    api.js          # API client
    ws.js           # WebSocket client
    render.js       # Render functions
    components/     # UI components
  css/
    style.css
```

### Migration Strategy

#### Phase 1: Create new `/app` route (1-2 hours)
- New static HTML file
- Basic state + API + WebSocket
- Message display + send
- Keep old UI at `/` for comparison

#### Phase 2: Feature parity (2-4 hours)
- Room switching
- Agent management (list, step, add, remove)
- Controls (start/stop/mode)
- Typing indicators

#### Phase 3: Advanced features (2-3 hours)
- Project management
- Persona management
- File uploads
- Artifacts display

#### Phase 4: Replace old UI
- Move new UI to `/`
- Remove old templates + HTMX dependencies
- Clean up server routes

### Benefits

1. **Zero Dependencies**: No npm packages, no build step
2. **Debuggable**: Plain JS, browser dev tools work perfectly
3. **Fast**: No framework overhead, minimal JS
4. **Maintainable**: Anyone who knows JS can modify it
5. **Portable**: Copy files anywhere, works immediately
6. **Single Source of Truth**: One state object, predictable updates

### Server Changes Required

Minimal changes - mostly removing template rendering:

```typescript
// Before (template rendering)
app.get('/', (req, res) => {
  res.render('index.html', { status, agents, ... });
});

// After (static file serving)
app.use(express.static('public'));
app.get('/', (req, res) => res.sendFile('public/index.html'));
```

Keep all `/api/*` routes unchanged.

### Estimated Effort

| Phase | Time | Risk |
|-------|------|------|
| Phase 1: Basic app | 1-2 hours | Low |
| Phase 2: Feature parity | 2-4 hours | Low |
| Phase 3: Advanced features | 2-3 hours | Low |
| Phase 4: Cleanup | 1 hour | Low |
| **Total** | **6-10 hours** | **Low** |

### Sample Code Structure

```html
<!DOCTYPE html>
<html>
<head>
  <title>Agent Arena</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
</head>
<body class="bg-gray-900 text-white">
  <div id="app"></div>

  <script type="module">
    // === STATE ===
    const state = { /* ... */ };

    // === API ===
    const api = { /* ... */ };

    // === WEBSOCKET ===
    function connectWS() { /* ... */ }

    // === RENDER ===
    function render() { /* ... */ }

    // === INIT ===
    async function init() {
      state.messages = await api.getMessages(state.room);
      state.agents = await api.getAgents();
      render();
      connectWS();
    }

    init();
  </script>
</body>
</html>
```

## Decision

**Recommendation**: Go with **Option B (Minimal Split)** - single HTML with one JS file and Tailwind CDN.

This gives:
- ✅ Zero build step
- ✅ Zero npm dependencies for frontend
- ✅ Single source of truth for state
- ✅ Easy to understand and modify
- ✅ Can iterate quickly
- ✅ Removes HTMX complexity entirely
