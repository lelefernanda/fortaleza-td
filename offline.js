// Local Offline Engine & Network Mock for Fortaleza-TD
(function() {
  console.log("🎮 Inicializando modo local offline de Fortaleza-TD...");

  // 1. Mock fetch endpoints
  const origFetch = window.fetch;
  window.fetch = async function(url, options = {}) {
    const urlStr = typeof url === "string" ? url : (url && url.url ? url.url : "");
    if (urlStr.includes("/api/turnstile")) {
      return new Response(JSON.stringify({ sitekey: "" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (urlStr.includes("/api/rooms/new")) {
      return new Response(JSON.stringify({ code: "SOLO" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (urlStr.includes("/api/rooms")) {
      return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (urlStr.includes("/api/highscores")) {
      return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (urlStr.includes("/api/ladder")) {
      return new Response(JSON.stringify({ ok: true, ladder: [], results: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return origFetch.apply(this, arguments);
  };

  // 2. Mock WebSocket for local room simulation
  class LocalWebSocket extends EventTarget {
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
      this.settings = {
        mapId: "sendero",
        mode: "classic",
        difficulty: "normal",
        turbo: false,
        closedDoors: []
      };
      this.door = 0;
      this.playerName = localStorage.getItem("td_name") || "Luna";

      setTimeout(() => {
        this.readyState = 1; // OPEN
        if (this.onopen) this.onopen({ type: "open" });
        this.dispatchEvent(new Event("open"));
      }, 50);
    }

    send(data) {
      let msg;
      try { msg = typeof data === "string" ? JSON.parse(data) : data; } catch { return; }
      this.handleClientMsg(msg);
    }

    emit(msg) {
      const event = { data: JSON.stringify(msg) };
      if (this.onmessage) this.onmessage(event);
      this.dispatchEvent(new MessageEvent("message", event));
    }

    handleClientMsg(msg) {
      switch (msg.type) {
        case "create_room":
        case "join_room": {
          this.playerName = msg.name || this.playerName;
          const roomCode = msg.code || "SOLO";
          this.emit({
            type: "room_joined",
            playerId: "p1",
            code: roomCode,
            isHost: true,
            spectator: false
          });
          this.emitLobby();
          break;
        }
        case "set_settings": {
          if (msg.settings) {
            this.settings = { ...this.settings, ...msg.settings };
          }
          this.emitLobby();
          break;
        }
        case "claim_door": {
          this.door = msg.door !== null && msg.door !== undefined ? msg.door : 0;
          this.emitLobby();
          break;
        }
        case "set_ready": {
          this.emitLobby();
          break;
        }
        case "start_game": {
          this.emit({ type: "countdown", seconds: 0, kind: "start" });
          const init = {
            mapId: this.settings.mapId || "sendero",
            mode: this.settings.mode || "classic",
            difficulty: this.settings.difficulty || "normal",
            turbo: this.settings.turbo || false,
            seed: Math.floor(Math.random() * 1000000),
            players: [{ id: "p1", name: this.playerName, color: "#38bdf8", door: this.door }],
            youAre: "p1",
            closedDoors: this.settings.closedDoors || []
          };
          this.emit({ type: "game_started", init });
          this.startGameSimulation(init);
          break;
        }
        case "cmd": {
          if (msg.cmd) {
            this.pendingCmds.push(msg.cmd);
          }
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

    emitLobby() {
      this.emit({
        type: "lobby_state",
        players: [{
          id: "p1",
          name: this.playerName,
          color: "#38bdf8",
          isHost: true,
          door: this.door,
          ready: true
        }],
        spectators: [],
        settings: this.settings,
        inGame: false,
        saved: null
      });
    }

    startGameSimulation(init) {
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

      // Emit first initial snapshot at t=0
      const initialSnap = window.__k0(this.engine.state);
      this.emit({
        type: "tick",
        t: 0,
        snap: initialSnap,
        events: []
      });

      this.resetTimer();
    }

    resetTimer() {
      if (this.timer) clearInterval(this.timer);
      const intervalMs = (1000 / 15) / this.speed;
      this.timer = setInterval(() => {
        if (this.paused || !this.engine) return;

        // Drain pending commands into the log for this tick
        while (this.pendingCmds.length > 0) {
          const cmd = this.pendingCmds.shift();
          this.log.push({
            t: this.currentTick,
            kind: "cmd",
            playerId: "p1",
            cmd: cmd
          });
        }

        const events = window.__mr(this.engine, { log: this.log }, this.currentTick);
        const snap = window.__k0(this.engine.state);

        this.emit({
          type: "tick",
          t: this.currentTick,
          snap: snap,
          events: events || []
        });

        if (this.engine.state.over) {
          this.emit({ type: "game_over", stats: this.engine.state.over });
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
      if (this.onclose) this.onclose({ type: "close" });
      this.dispatchEvent(new Event("close"));
    }
  }

  LocalWebSocket.CONNECTING = 0;
  LocalWebSocket.OPEN = 1;
  LocalWebSocket.CLOSING = 2;
  LocalWebSocket.CLOSED = 3;

  // Override WebSocket in window
  window.WebSocket = LocalWebSocket;

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
