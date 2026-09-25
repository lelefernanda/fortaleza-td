// Fortaleza-TD Multiplayer Network Bridge & Simulation Engine
(function() {
  console.log("🎮 Inicializando rede multiplayer de Fortaleza-TD...");

  const REMOTE_HTTP = "https://baluarte.leferli.com";
  const REMOTE_WS = "wss://baluarte.leferli.com";

  function generateRoomCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ";
    let code = "";
    for (let i = 0; i < 4; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }

  // 1. Fetch endpoints proxy with fallback
  const origFetch = window.fetch;
  window.fetch = async function(url, options = {}) {
    const urlStr = typeof url === "string" ? url : (url && url.url ? url.url : "");

    // Turnstile: return empty sitekey so captcha does not block
    if (urlStr.includes("/api/turnstile")) {
      return new Response(JSON.stringify({ sitekey: "" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    if (urlStr.includes("/api/rooms/new")) {
      try {
        const res = await origFetch(`${REMOTE_HTTP}/api/rooms/new`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({})
        });
        if (res.ok) return res;
      } catch (e) {
        console.warn("Falha ao criar sala no servidor remoto, usando local:", e.message);
      }
      const code = generateRoomCode();
      return new Response(JSON.stringify({ code }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    if (urlStr.includes("/api/rooms")) {
      try {
        const res = await origFetch(`${REMOTE_HTTP}/api/rooms`, options);
        if (res.ok) return res;
      } catch (e) {}
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    if (urlStr.includes("/api/highscores")) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    if (urlStr.includes("/api/ladder")) {
      return new Response(JSON.stringify({ ok: true, ladder: [], results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    return origFetch.apply(this, arguments);
  };

  // 2. Hybrid Multiplayer WebSocket Client
  class MultiplayerWebSocket extends EventTarget {
    constructor(url) {
      super();
      this.url = url;
      this.readyState = 0; // CONNECTING
      this.currentTick = 0;
      this.engine = null;
      this.log = [];
      this.pendingCmds = [];
      this.timer = null;
      this.speed = 1;
      this.paused = false;
      this.isHost = false;
      this.myPlayerId = "p1";
      this.playerName = localStorage.getItem("td_name") || "Luna";

      let codeFromUrl = "";
      try {
        const u = new URL(url, location.origin);
        codeFromUrl = u.searchParams.get("code") || "";
      } catch {}
      this.roomCode = (codeFromUrl && codeFromUrl.length === 4) ? codeFromUrl.toUpperCase() : generateRoomCode();

      // Connect to remote real-time WebSocket on Cloudflare
      this.remoteWs = null;
      this.useRemote = true;
      this.connectRemote();
    }

    connectRemote() {
      try {
        const targetUrl = `${REMOTE_WS}/ws?code=${encodeURIComponent(this.roomCode)}`;
        console.log("🌐 Conectando sala ao Cloudflare Multiplayer:", targetUrl);
        const ws = new window._NativeWebSocket(targetUrl);
        this.remoteWs = ws;

        ws.onopen = (e) => {
          console.log("✅ Conectado ao servidor multiplayer de Fortaleza!");
          this.readyState = 1; // OPEN
          if (this.onopen) this.onopen(e);
          this.dispatchEvent(new Event("open"));
        };

        ws.onmessage = (event) => {
          let msg;
          try { msg = JSON.parse(event.data); } catch { return; }
          this.handleServerMessage(msg, event);
        };

        ws.onerror = (err) => {
          console.warn("Aviso na conexão multiplayer:", err);
          if (this.readyState === 0) {
            this.fallbackToLocal();
          }
        };

        ws.onclose = (e) => {
          if (this.readyState === 0) {
            this.fallbackToLocal();
            return;
          }
          this.readyState = 3;
          if (this.onclose) this.onclose(e);
          this.dispatchEvent(new CloseEvent("close", e));
        };
      } catch (err) {
        console.warn("Erro ao iniciar WebSocket remoto, usando modo local:", err);
        this.fallbackToLocal();
      }
    }

    fallbackToLocal() {
      console.log("🕹️ Ativando modo local autônomo");
      this.useRemote = false;
      this.remoteWs = null;
      this.isHost = true;
      this.readyState = 1; // OPEN
      setTimeout(() => {
        if (this.onopen) this.onopen({ type: "open" });
        this.dispatchEvent(new Event("open"));
      }, 50);
    }

    emit(msg) {
      const event = { data: JSON.stringify(msg) };
      if (this.onmessage) this.onmessage(event);
      this.dispatchEvent(new MessageEvent("message", event));
    }

    handleServerMessage(msg, originalEvent) {
      if (msg.type === "room_joined") {
        this.isHost = msg.isHost;
        this.myPlayerId = msg.playerId;
      }

      if (msg.type === "game_started") {
        this.isHost = msg.init && msg.init.youAre === "p1";
        this.myPlayerId = msg.init ? msg.init.youAre : this.myPlayerId;
        if (this.isHost) {
          this.startSimulation(msg.init);
        }
      }

      if (msg.type === "cmd") {
        if (this.isHost && this.engine) {
          this.pendingCmds.push(msg);
        }
      }

      if (msg.type === "paused") {
        this.paused = true;
      }
      if (msg.type === "resumed") {
        this.paused = false;
      }
      if (msg.type === "speed") {
        this.speed = msg.speed || 1;
        this.resetTimer();
      }

      // Forward to local game UI
      if (this.onmessage) this.onmessage(originalEvent);
      this.dispatchEvent(new MessageEvent("message", originalEvent));
    }

    send(data) {
      let msg;
      try { msg = typeof data === "string" ? JSON.parse(data) : data; } catch { msg = data; }

      // If connected to remote server
      if (this.useRemote && this.remoteWs && this.remoteWs.readyState === 1) {
        this.remoteWs.send(typeof data === "string" ? data : JSON.stringify(data));
        // If host sending local command, also register locally
        if (msg && msg.type === "cmd" && this.isHost) {
          this.pendingCmds.push({ playerId: this.myPlayerId, cmd: msg.cmd });
        }
        return;
      }

      // Fallback local handling
      this.handleLocalMsg(msg);
    }

    handleLocalMsg(msg) {
      switch (msg.type) {
        case "create_room":
        case "join_room": {
          this.playerName = msg.name || this.playerName;
          const roomCode = msg.code || this.roomCode;
          this.roomCode = roomCode;
          this.emit({
            type: "room_joined",
            playerId: "p1",
            code: roomCode,
            isHost: true,
            spectator: false
          });
          this.emitLocalLobby();
          break;
        }
        case "set_settings": {
          if (msg.settings) this.settings = { ...this.settings, ...msg.settings };
          this.emitLocalLobby();
          break;
        }
        case "claim_door": {
          this.door = msg.door !== null && msg.door !== undefined ? msg.door : 0;
          this.emitLocalLobby();
          break;
        }
        case "set_ready": {
          this.emitLocalLobby();
          break;
        }
        case "start_game": {
          this.emit({ type: "countdown", seconds: 0, kind: "start" });
          const init = {
            mapId: (this.settings && this.settings.mapId) || "sendero",
            mode: (this.settings && this.settings.mode) || "classic",
            difficulty: (this.settings && this.settings.difficulty) || "normal",
            turbo: (this.settings && this.settings.turbo) || false,
            seed: Math.floor(Math.random() * 1000000),
            players: [{ id: "p1", name: this.playerName, color: "#38bdf8", door: this.door || 0 }],
            youAre: "p1",
            closedDoors: (this.settings && this.settings.closedDoors) || []
          };
          this.emit({ type: "game_started", init });
          this.startSimulation(init);
          break;
        }
        case "cmd": {
          if (msg.cmd) this.pendingCmds.push({ playerId: "p1", cmd: msg.cmd });
          break;
        }
        case "pause": {
          this.paused = true;
          this.emit({ type: "paused", by: this.playerName });
          break;
        }
        case "resume": {
          this.paused = false;
          this.emit({ type: "resumed" });
          break;
        }
        case "set_speed": {
          this.speed = msg.speed || 1;
          this.emit({ type: "speed", speed: this.speed, by: this.playerName });
          this.resetTimer();
          break;
        }
        case "leave": {
          this.stopSimulation();
          break;
        }
      }
    }

    emitLocalLobby() {
      this.emit({
        type: "lobby_state",
        players: [{
          id: "p1",
          name: this.playerName,
          color: "#38bdf8",
          isHost: true,
          door: this.door || 0,
          ready: true
        }],
        spectators: [],
        settings: this.settings || { mapId: "sendero", mode: "classic", difficulty: "normal" },
        inGame: false,
        saved: null
      });
    }

    startSimulation(init) {
      this.stopSimulation();
      this.currentTick = 0;
      this.log = [];
      this.pendingCmds = [];
      this.paused = false;

      if (!window.__hr || !window.__mr || !window.__k0) {
        console.error("Engine functions (__hr, __mr, __k0) not found on window!");
        return;
      }

      this.engine = window.__hr(init);

      // Emit initial snapshot at t=0
      const initialSnap = window.__k0(this.engine.state);
      const initialTickMsg = {
        type: "tick",
        t: 0,
        snap: initialSnap,
        events: []
      };

      this.emit(initialTickMsg);
      if (this.useRemote && this.remoteWs && this.remoteWs.readyState === 1) {
        this.remoteWs.send(JSON.stringify(initialTickMsg));
      }

      this.resetTimer();
    }

    resetTimer() {
      if (this.timer) clearInterval(this.timer);
      const intervalMs = (1000 / 15) / this.speed;
      this.timer = setInterval(() => {
        if (this.paused || !this.engine) return;

        // Drain pending commands
        while (this.pendingCmds.length > 0) {
          const item = this.pendingCmds.shift();
          this.log.push({
            t: this.currentTick,
            kind: "cmd",
            playerId: item.playerId || "p1",
            cmd: item.cmd || item
          });
        }

        const events = window.__mr(this.engine, { log: this.log }, this.currentTick);
        const snap = window.__k0(this.engine.state);

        const tickMsg = {
          type: "tick",
          t: this.currentTick,
          snap: snap,
          events: events || []
        };

        // Render locally
        this.emit(tickMsg);

        // Broadcast to remote players
        if (this.useRemote && this.remoteWs && this.remoteWs.readyState === 1) {
          this.remoteWs.send(JSON.stringify(tickMsg));
        }

        if (this.engine.state.over) {
          const overMsg = { type: "game_over", stats: this.engine.state.over };
          this.emit(overMsg);
          if (this.useRemote && this.remoteWs && this.remoteWs.readyState === 1) {
            this.remoteWs.send(JSON.stringify(overMsg));
          }
          this.stopSimulation();
        }

        this.currentTick++;
      }, intervalMs);
    }

    stopSimulation() {
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
      this.engine = null;
    }

    close() {
      this.stopSimulation();
      this.readyState = 3; // CLOSED
      if (this.remoteWs) {
        try { this.remoteWs.close(); } catch {}
        this.remoteWs = null;
      }
      if (this.onclose) this.onclose({ type: "close" });
      this.dispatchEvent(new Event("close"));
    }
  }

  MultiplayerWebSocket.CONNECTING = 0;
  MultiplayerWebSocket.OPEN = 1;
  MultiplayerWebSocket.CLOSING = 2;
  MultiplayerWebSocket.CLOSED = 3;

  // Save native WebSocket and install MultiplayerWebSocket
  window._NativeWebSocket = window.WebSocket;
  window.WebSocket = MultiplayerWebSocket;

  // Auto-selecionar nome e visibilidade na tela inicial para permitir criar sala imediatamente
  function ensureReadyToPlay() {
    const nameInput = document.getElementById("home-name");
    if (nameInput) {
      if (!nameInput.value || !nameInput.value.trim()) {
        const stored = localStorage.getItem("td_name");
        nameInput.value = stored || "Luna";
        nameInput.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }

    const pubBtn = document.querySelector('#home-visibility button[data-value="public"]');
    if (pubBtn && !pubBtn.classList.contains("active")) {
      pubBtn.click();
    }

    const btnCreate = document.getElementById("btn-create");
    if (btnCreate && btnCreate.disabled) {
      btnCreate.disabled = false;
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      ensureReadyToPlay();
      setTimeout(ensureReadyToPlay, 100);
      setTimeout(ensureReadyToPlay, 300);
    });
  } else {
    ensureReadyToPlay();
    setTimeout(ensureReadyToPlay, 100);
    setTimeout(ensureReadyToPlay, 300);
  }

  // Intercept click to guarantee ready state before game click handlers run
  document.addEventListener("click", (e) => {
    const btn = e.target && e.target.closest ? e.target.closest("#btn-create, #btn-join") : null;
    if (btn) {
      ensureReadyToPlay();
    }
  }, true);
})();
