// ============================================================================
// UNO TABELLA 1-9 DUEL - LOGICA DI GIOCO & MULTIPLAYER MOBILE/DESKTOP
// ============================================================================

const COLORS = ['red', 'blue', 'green', 'yellow'];
const PEER_PREFIX = 'unogrid19-room-';
const CLOUD_RELAY_PREFIX = 'unogrid19_duel_v2_';

// --- Sintetizzatore Audio + Vibrazione Aptica Mobile ---
class SoundFX {
  constructor() {
    this.enabled = true;
    this.ctx = null;
  }

  init() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) this.ctx = new AudioCtx();
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  vibrate(pattern) {
    if (navigator.vibrate) {
      try {
        navigator.vibrate(pattern);
      } catch (_) {}
    }
  }

  playTone(freq, type = 'sine', duration = 0.12, gainVal = 0.15, delay = 0) {
    if (!this.enabled) return;
    try {
      this.init();
      if (!this.ctx) return;
      const now = this.ctx.currentTime + delay;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, now);
      gain.gain.setValueAtTime(gainVal, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(now);
      osc.stop(now + duration);
    } catch (_) {}
  }

  cardDraw() {
    this.vibrate(18);
    this.playTone(340, 'triangle', 0.09, 0.16, 0);
    this.playTone(520, 'sine', 0.11, 0.14, 0.04);
  }

  cardPlace(streak = 1) {
    this.vibrate([25, 30, 35]);
    const base = 440 + Math.min(streak, 8) * 45;
    this.playTone(base, 'triangle', 0.12, 0.18, 0);
    this.playTone(base * 1.25, 'sine', 0.18, 0.18, 0.07);
  }

  duplicateMiss() {
    this.vibrate([70, 50, 90]);
    this.playTone(240, 'sawtooth', 0.16, 0.13, 0);
    this.playTone(175, 'sawtooth', 0.24, 0.13, 0.12);
  }

  playerJoined() {
    this.vibrate([40, 40, 80]);
    this.playTone(587.33, 'triangle', 0.14, 0.18, 0);
    this.playTone(880, 'triangle', 0.2, 0.2, 0.1);
  }

  victory() {
    this.vibrate([100, 60, 100, 60, 180]);
    [523.25, 659.25, 783.99, 1046.5].forEach((f, idx) => {
      this.playTone(f, 'triangle', 0.24, 0.2, idx * 0.11);
    });
  }
}

const sfx = new SoundFX();

// --- Stato Globale Applicazione ---
const app = {
  mode: null, // 'online' | 'local'
  role: null, // 'host' (0) | 'guest' (1)
  myIndex: 0, // 0 per Host, 1 per Guest
  roomCode: null,
  opponentConnected: false,
  lanOrigin: null,
  peer: null,
  conn: null,
  bc: null,
  sse: null,
  cloudSse: null,
  retryInterval: null,
  seenMessages: new Set(),
  autoPlaceTimer: null,
  passTurnTimer: null,
  state: null
};

function createInitialGameState(p1Name = 'Giocatore 1', p2Name = 'Giocatore 2') {
  const deck = buildShuffledDeck();
  return {
    players: [
      { name: p1Name, board: createEmptyBoard(), maxStreak: 0 },
      { name: p2Name, board: createEmptyBoard(), maxStreak: 0 }
    ],
    deck,
    discardPile: [],
    turn: 0,
    phase: 'DRAWING', // 'DRAWING' | 'PLACING' | 'DUPLICATE_WAIT' | 'GAME_OVER'
    pendingCard: null,
    lastActionText: 'Tocca il mazzo UNO per pescare!',
    lastActionType: 'neutral',
    currentStreak: 0,
    totalDraws: 0,
    winner: null,
    duplicateSlotNumber: null
  };
}

function createEmptyBoard() {
  const b = {};
  for (let n = 1; n <= 9; n++) {
    b[n] = null;
  }
  return b;
}

function buildShuffledDeck() {
  const deck = [];
  let idCounter = 1;
  for (const color of COLORS) {
    for (let num = 1; num <= 9; num++) {
      for (let copy = 0; copy < 2; copy++) {
        deck.push({
          id: `c_${idCounter++}_${Math.random().toString(36).slice(2, 6)}`,
          number: num,
          color,
          tilt: (Math.random() * 5 - 2.5).toFixed(1)
        });
      }
    }
  }
  return shuffleArray(deck);
}

function shuffleArray(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// ============================================================================
// MULTIPLAYER NETWORKING (Cloud HTTPS Relay + PeerJS WebRTC + BroadcastChannel)
// ============================================================================

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function sendNetMessage(type, payload = {}) {
  if (app.mode !== 'online' || !app.roomCode) return;
  const msg = {
    msgId: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    roomCode: app.roomCode,
    senderRole: app.role,
    type,
    payload
  };
  app.seenMessages.add(msg.msgId);

  // 1. PeerJS WebRTC DataChannel
  if (app.conn && app.conn.open) {
    try {
      app.conn.send(msg);
    } catch (_) {}
  }

  // 2. Cloud Relay HTTPS (ntfy.sh) - funziona anche sotto 4G/5G e mentre cambi app per WhatsApp!
  const topic = `${CLOUD_RELAY_PREFIX}${app.roomCode}`;
  fetch(`https://ntfy.sh/${topic}`, {
    method: 'POST',
    body: JSON.stringify(msg)
  }).catch(() => {});

  // 3. BroadcastChannel (stesso browser)
  if (app.bc) {
    try {
      app.bc.postMessage(msg);
    } catch (_) {}
  }

  // 4. Server Relay locale (se attivo)
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    fetch('/api/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg)
    }).catch(() => {});
  }
}

function handleIncomingNetMessage(msg) {
  if (!msg || !msg.msgId || msg.roomCode !== app.roomCode) return;
  if (app.seenMessages.has(msg.msgId)) return;
  app.seenMessages.add(msg.msgId);

  const { type, payload } = msg;

  if (type === 'GUEST_JOINED' && app.role === 'host') {
    const p1Name = getPlayerNameInput();
    const p2Name = payload.guestName || 'Giocatore 2';
    const wasAlreadyConnected = app.opponentConnected;
    app.opponentConnected = true;
    setConnectionStatus(true);

    if (!wasAlreadyConnected) {
      sfx.playerJoined();
      // Azzera il tavolo di riscaldamento e inizia la vera sfida 0 a 0!
      clearTimers();
      app.state = createInitialGameState(p1Name, p2Name);
      app.state.lastActionText = `🎉 ${p2Name} è entrato! Tocca a ${p1Name} pescare!`;
    } else if (app.state) {
      app.state.players[1].name = p2Name;
    }

    enterGameScreen();
    renderAll();
    broadcastState();
  } else if (type === 'STATE_SYNC') {
    const prevDraws = app.state ? app.state.totalDraws : 0;
    const prevPhase = app.state ? app.state.phase : null;
    app.state = payload.state;
    app.opponentConnected = true;
    setConnectionStatus(true);

    if (!document.getElementById('game-screen').classList.contains('active')) {
      enterGameScreen();
    }

    if (app.state.totalDraws > prevDraws) {
      sfx.cardDraw();
      if (app.state.phase === 'DUPLICATE_WAIT') {
        setTimeout(() => sfx.duplicateMiss(), 150);
      }
    } else if (prevPhase === 'PLACING' && app.state.phase === 'DRAWING') {
      sfx.cardPlace(app.state.currentStreak);
    } else if (prevPhase !== 'GAME_OVER' && app.state.phase === 'GAME_OVER') {
      sfx.victory();
    }

    renderAll();
    scheduleAutoActionsIfNeeded();
  } else if (type === 'PLAYER_ACTION' && app.role === 'host') {
    app.opponentConnected = true;
    setConnectionStatus(true);
    if (payload.action === 'DRAW') {
      executeDrawCard(1);
    } else if (payload.action === 'PLACE') {
      executePlaceCard(1, payload.slotNumber);
    } else if (payload.action === 'REMATCH') {
      executeRematch();
    }
  } else if (type === 'EMOJI_REACTION') {
    spawnFloatingEmoji(payload.emoji);
  }
}

function broadcastState() {
  if (app.mode === 'online' && app.role === 'host') {
    sendNetMessage('STATE_SYNC', { state: app.state });
  }
}

function setupAuxiliaryChannels(roomCode) {
  // 1. BroadcastChannel locale
  if ('BroadcastChannel' in window) {
    if (app.bc) app.bc.close();
    app.bc = new BroadcastChannel(`uno_grid_${roomCode}`);
    app.bc.onmessage = (ev) => handleIncomingNetMessage(ev.data);
  }

  // 2. Cloud Relay HTTPS SSE (ntfy.sh) con recupero ultimi messaggi (fondamentale quando torni da WhatsApp!)
  connectCloudRelay(roomCode);

  // 3. Server-Sent Events locale (solo su localhost)
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    if (app.sse) app.sse.close();
    try {
      const sse = new EventSource(`/api/stream?room=${encodeURIComponent(roomCode)}`);
      sse.onmessage = (ev) => {
        try {
          handleIncomingNetMessage(JSON.parse(ev.data));
        } catch (_) {}
      };
      sse.onerror = () => sse.close();
      app.sse = sse;
    } catch (_) {}
  }
}

function connectCloudRelay(roomCode) {
  if (app.cloudSse) {
    try {
      app.cloudSse.close();
    } catch (_) {}
  }
  try {
    const topic = `${CLOUD_RELAY_PREFIX}${roomCode}`;
    // since=2m recupera anche i messaggi inviati mentre il giocatore era su WhatsApp!
    const cloudSse = new EventSource(`https://ntfy.sh/${topic}/sse?since=2m`);
    cloudSse.onmessage = (ev) => {
      try {
        const wrapper = JSON.parse(ev.data);
        if (wrapper && wrapper.message) {
          const innerMsg = JSON.parse(wrapper.message);
          handleIncomingNetMessage(innerMsg);
        }
      } catch (_) {}
    };
    app.cloudSse = cloudSse;
  } catch (_) {}
}

async function pollCloudRelayOnce(roomCode) {
  try {
    const topic = `${CLOUD_RELAY_PREFIX}${roomCode}`;
    const res = await fetch(`https://ntfy.sh/${topic}/json?poll=1&since=3m`);
    const text = await res.text();
    const lines = text.trim().split('\n');
    for (const line of lines) {
      if (!line) continue;
      try {
        const wrapper = JSON.parse(line);
        if (wrapper && wrapper.message) {
          handleIncomingNetMessage(JSON.parse(wrapper.message));
        }
      } catch (_) {}
    }
  } catch (_) {}
}

function getPeerConfig() {
  return {
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun.cloudflare.com:3478' }
      ]
    }
  };
}

function hostOnlineRoom() {
  const code = generateRoomCode();
  app.mode = 'online';
  app.role = 'host';
  app.myIndex = 0;
  app.roomCode = code;
  app.opponentConnected = false;

  const p1Name = getPlayerNameInput();
  // Crea subito il tavolo così entri immediatamente nella sala!
  app.state = createInitialGameState(p1Name, 'In attesa... 📲');
  app.state.lastActionText = `Stanza ${code} pronta! Invita l'altro giocatore o allenati nell'attesa.`;

  setConnectionStatus(false);
  setupAuxiliaryChannels(code);
  initHostPeer(code);

  // Entra SUBITO nel tavolo da gioco!
  enterGameScreen();
}

function initHostPeer(code) {
  if (!window.Peer) return;
  if (app.peer) app.peer.destroy();

  const peer = new Peer(`${PEER_PREFIX}${code}`, getPeerConfig());
  app.peer = peer;

  peer.on('connection', (conn) => {
    app.conn = conn;
    conn.on('data', (data) => handleIncomingNetMessage(data));
    conn.on('open', () => {
      setConnectionStatus(true);
      if (app.state) {
        broadcastState();
      }
    });
  });

  peer.on('disconnected', () => {
    try {
      peer.reconnect();
    } catch (_) {}
  });

  peer.on('error', (err) => {
    console.warn('PeerJS info:', err.type);
  });
}

function joinOnlineRoom(rawCode) {
  const code = (rawCode || '').trim().toUpperCase();
  if (!code || code.length < 3) {
    showLobbyError('Inserisci un codice stanza valido.');
    return;
  }

  app.mode = 'online';
  app.role = 'guest';
  app.myIndex = 1;
  app.roomCode = code;
  app.opponentConnected = false;
  hideLobbyError();

  const guestName = getPlayerNameInput();

  // Crea uno stato provvisorio così anche il Giocatore 2 entra SUBITO nella sala!
  app.state = createInitialGameState('Giocatore 1', guestName);
  app.state.lastActionText = `⏳ Connessione alla stanza ${code} in corso...`;
  setConnectionStatus(false);
  enterGameScreen();

  setupAuxiliaryChannels(code);

  // Invia subito la richiesta di ingresso su tutti i canali (incluso Cloud Relay)
  sendNetMessage('GUEST_JOINED', { guestName });

  // Continua a bussare ogni 2.2s finché l'Host non risponde con lo stato sincronizzato
  if (app.retryInterval) clearInterval(app.retryInterval);
  app.retryInterval = setInterval(() => {
    if (app.opponentConnected) {
      clearInterval(app.retryInterval);
      return;
    }
    sendNetMessage('GUEST_JOINED', { guestName });
    pollCloudRelayOnce(code);
  }, 2200);

  if (window.Peer) {
    if (app.peer) app.peer.destroy();
    const peer = new Peer(getPeerConfig());
    app.peer = peer;

    const attemptConnect = () => {
      if (app.opponentConnected) return;
      const conn = peer.connect(`${PEER_PREFIX}${code}`, { reliable: true });
      app.conn = conn;

      conn.on('open', () => {
        setConnectionStatus(true);
        sendNetMessage('GUEST_JOINED', { guestName });
      });

      conn.on('data', (data) => handleIncomingNetMessage(data));
    };

    peer.on('open', () => {
      attemptConnect();
    });
  }
}

// ============================================================================
// LOGICA DI GIOCO (PESCA, POSIZIONA, PASSA IL TURNO, VITTORIA)
// ============================================================================

function isMyTurnToAct() {
  if (!app.state || app.state.phase === 'GAME_OVER') return false;
  if (app.mode === 'local') return true;
  // Mentre l'Host è in attesa dell'avversario, può fare pescate di riscaldamento!
  if (app.role === 'host' && !app.opponentConnected) return true;
  if (app.role === 'guest' && !app.opponentConnected) return false;
  return app.state.turn === app.myIndex;
}

function getActiveActorIndex() {
  if (app.mode === 'local') return app.state.turn;
  if (app.role === 'host' && !app.opponentConnected) return 0;
  return app.myIndex;
}

function handleDeckClick() {
  if (!app.state) return;
  if (!isMyTurnToAct()) return;

  if (app.state.phase === 'PLACING' && app.state.pendingCard) {
    requestPlaceCard(app.state.pendingCard.number);
    return;
  }

  if (app.state.phase !== 'DRAWING') return;

  const actor = getActiveActorIndex();
  if (app.mode === 'online' && app.role === 'guest') {
    sendNetMessage('PLAYER_ACTION', { action: 'DRAW' });
  } else {
    executeDrawCard(actor);
  }
}

function requestPlaceCard(slotNumber) {
  if (!app.state || app.state.phase !== 'PLACING' || !app.state.pendingCard) return;
  if (!isMyTurnToAct()) return;
  if (app.state.pendingCard.number !== slotNumber) return;

  const actor = getActiveActorIndex();
  if (app.mode === 'online' && app.role === 'guest') {
    sendNetMessage('PLAYER_ACTION', { action: 'PLACE', slotNumber });
  } else {
    executePlaceCard(actor, slotNumber);
  }
}

function executeDrawCard(playerIdx) {
  const st = app.state;
  if (!st || st.turn !== playerIdx || st.phase !== 'DRAWING') return;

  clearTimers();

  if (st.deck.length === 0) {
    if (st.discardPile.length > 0) {
      st.deck = shuffleArray(st.discardPile);
      st.discardPile = [];
    } else {
      st.deck = buildShuffledDeck();
    }
  }

  const card = st.deck.pop();
  st.pendingCard = card;
  st.totalDraws += 1;
  st.duplicateSlotNumber = null;

  sfx.cardDraw();

  const player = st.players[playerIdx];
  const existingCard = player.board[card.number];

  if (!existingCard) {
    st.phase = 'PLACING';
    st.lastActionText = `Uscito ${card.number}! Va sulla casella ${card.number}.`;
    st.lastActionType = 'success';
  } else {
    st.phase = 'DUPLICATE_WAIT';
    st.duplicateSlotNumber = card.number;
    st.currentStreak = 0;
    const isWarmup = app.mode === 'online' && app.role === 'host' && !app.opponentConnected;
    st.lastActionText = isWarmup
      ? `Il ${card.number} è già uscito! (Riscaldamento in attesa del G2)`
      : `Il ${card.number} è già uscito! Passa la mano...`;
    st.lastActionType = 'duplicate';
    setTimeout(() => sfx.duplicateMiss(), 150);

    app.passTurnTimer = setTimeout(() => {
      if (!app.state || app.state.phase !== 'DUPLICATE_WAIT') return;
      st.discardPile.push(card);
      st.pendingCard = null;
      st.duplicateSlotNumber = null;
      // Se siamo in riscaldamento da soli, il turno resta a noi finché non entra l'amico
      if (app.mode === 'online' && app.role === 'host' && !app.opponentConnected) {
        st.turn = 0;
        st.phase = 'DRAWING';
        st.lastActionText = `Pesca ancora mentre aspetti l'altro giocatore!`;
      } else {
        st.turn = 1 - playerIdx;
        st.phase = 'DRAWING';
        st.lastActionText = `Tocca a ${st.players[st.turn].name} pescare!`;
      }
      st.lastActionType = 'neutral';
      renderAll();
      broadcastState();
    }, 1450);
  }

  renderAll();
  broadcastState();
  scheduleAutoActionsIfNeeded();
}

function executePlaceCard(playerIdx, slotNumber) {
  const st = app.state;
  if (!st || st.turn !== playerIdx || st.phase !== 'PLACING' || !st.pendingCard) return;
  if (st.pendingCard.number !== slotNumber) return;

  clearTimers();

  const player = st.players[playerIdx];
  player.board[slotNumber] = st.pendingCard;
  st.pendingCard = null;
  st.currentStreak += 1;
  if (st.currentStreak > player.maxStreak) {
    player.maxStreak = st.currentStreak;
  }

  const filledCount = countFilledSlots(player.board);
  if (filledCount >= 9) {
    if (app.mode === 'online' && app.role === 'host' && !app.opponentConnected) {
      // Se finisci la tabella durante il riscaldamento, la riazzera per continuare ad allenarti
      player.board = createEmptyBoard();
      st.phase = 'DRAWING';
      st.lastActionText = `🔥 Tabella completata in riscaldamento! In attesa del Giocatore 2...`;
      sfx.victory();
    } else {
      st.phase = 'GAME_OVER';
      st.winner = playerIdx;
      st.lastActionText = `🎉 ${player.name} ha completato 1–9!`;
      st.lastActionType = 'success';
      sfx.victory();
    }
  } else {
    st.phase = 'DRAWING';
    st.lastActionText = `Casella ${slotNumber} presa! Pesca ancora!`;
    st.lastActionType = 'success';
    sfx.cardPlace(st.currentStreak);
  }

  renderAll();
  broadcastState();
}

function executeRematch() {
  if (!app.state) return;
  clearTimers();
  const p1Name = app.state.players[0].name;
  const p2Name = app.state.players[1].name;
  const nextStarter = app.state.winner !== null ? 1 - app.state.winner : 0;
  app.state = createInitialGameState(p1Name, p2Name);
  app.state.turn = nextStarter;
  app.state.lastActionText = `Rivincita! Inizia ${app.state.players[nextStarter].name}.`;
  renderAll();
  broadcastState();
}

function scheduleAutoActionsIfNeeded() {
  const st = app.state;
  if (!st) return;

  const autoPlaceChecked = document.getElementById('chk-auto-place').checked;
  if (autoPlaceChecked && st.phase === 'PLACING' && st.pendingCard && isMyTurnToAct()) {
    clearTimeout(app.autoPlaceTimer);
    const num = st.pendingCard.number;
    app.autoPlaceTimer = setTimeout(() => {
      requestPlaceCard(num);
    }, 550);
  }
}

function clearTimers() {
  if (app.autoPlaceTimer) clearTimeout(app.autoPlaceTimer);
  if (app.passTurnTimer) clearTimeout(app.passTurnTimer);
}

function countFilledSlots(board) {
  let count = 0;
  for (let n = 1; n <= 9; n++) {
    if (board[n]) count++;
  }
  return count;
}

// ============================================================================
// RENDERING INTERFACCIA GRAFICA
// ============================================================================

function renderAll() {
  const st = app.state;
  if (!st) return;

  document.getElementById('p1-name-label').textContent = st.players[0].name;
  document.getElementById('p2-name-label').textContent = st.players[1].name;
  document.getElementById('p1-score-badge').textContent = `${countFilledSlots(st.players[0].board)}/9`;
  document.getElementById('p2-score-badge').textContent = `${countFilledSlots(st.players[1].board)}/9`;

  // Mostra/nascondi barra invito rapida dentro la sala quando sei in attesa del Giocatore 2
  const inGameInviteBanner = document.getElementById('in-game-invite-banner');
  if (inGameInviteBanner) {
    if (app.mode === 'online' && !app.opponentConnected) {
      inGameInviteBanner.style.display = 'flex';
      document.getElementById('banner-room-code').textContent = app.roomCode;
      document.getElementById('banner-wait-msg').textContent =
        app.role === 'host'
          ? `Stanza ${app.roomCode} • In attesa dell'amico (puoi allenarti intanto!)`
          : `Connessione alla stanza ${app.roomCode} in corso...`;
    } else {
      inGameInviteBanner.style.display = 'none';
    }
  }

  const p1You = document.getElementById('p1-you-tag');
  const p2You = document.getElementById('p2-you-tag');
  if (app.mode === 'local') {
    p1You.style.display = st.turn === 0 ? 'inline-block' : 'none';
    p2You.style.display = st.turn === 1 ? 'inline-block' : 'none';
    p1You.textContent = 'TURNO';
    p2You.textContent = 'TURNO';
  } else {
    p1You.style.display = app.myIndex === 0 ? 'inline-block' : 'none';
    p2You.style.display = app.myIndex === 1 ? 'inline-block' : 'none';
    p1You.textContent = 'TU';
    p2You.textContent = 'TU';
  }

  document.getElementById('board-left').classList.toggle('active-board', st.turn === 0);
  document.getElementById('board-right').classList.toggle('active-board', st.turn === 1);

  const turnHud = document.getElementById('turn-hud');
  const turnBadge = document.getElementById('turn-badge');
  const turnPrompt = document.getElementById('turn-prompt');
  const myTurn = isMyTurnToAct();

  turnHud.classList.toggle('my-turn', myTurn);
  if (app.mode === 'local') {
    turnBadge.textContent = st.players[st.turn].name.toUpperCase();
    turnBadge.className = 'turn-indicator-badge';
  } else if (app.mode === 'online' && !app.opponentConnected) {
    turnBadge.textContent = app.role === 'host' ? 'ATTESA G2' : 'CONNESSIONE';
    turnBadge.className = 'turn-indicator-badge opponent';
  } else if (myTurn) {
    turnBadge.textContent = 'TUO TURNO';
    turnBadge.className = 'turn-indicator-badge';
  } else {
    turnBadge.textContent = st.players[st.turn].name.toUpperCase();
    turnBadge.className = 'turn-indicator-badge opponent';
  }

  turnPrompt.textContent = st.lastActionText;
  document.getElementById('streak-pill').textContent = `🔥 ${st.currentStreak}`;

  const deckEl = document.getElementById('uno-deck');
  const canDrawNow = myTurn && st.phase === 'DRAWING';
  deckEl.classList.toggle('can-draw', canDrawNow);
  deckEl.classList.toggle('disabled', !canDrawNow && !(myTurn && st.phase === 'PLACING'));
  document.getElementById('deck-count').textContent = `${st.deck.length} carte`;

  const drawnContainer = document.getElementById('drawn-card-container');
  const feedbackEl = document.getElementById('action-feedback');

  if (st.pendingCard) {
    drawnContainer.style.display = 'block';
    drawnContainer.innerHTML = renderUnoCardHTML(st.pendingCard);
    drawnContainer.onclick = () => {
      if (st.phase === 'PLACING' && isMyTurnToAct()) {
        requestPlaceCard(st.pendingCard.number);
      }
    };
  } else {
    drawnContainer.style.display = 'none';
    drawnContainer.innerHTML = '';
  }

  feedbackEl.textContent = st.lastActionText;
  feedbackEl.className = `action-feedback-pill ${st.lastActionType === 'success' ? 'success' : st.lastActionType === 'duplicate' ? 'duplicate' : ''}`;

  renderPlayerGrid('grid-p1', 0);
  renderPlayerGrid('grid-p2', 1);

  const victoryModal = document.getElementById('victory-modal');
  if (st.phase === 'GAME_OVER' && st.winner !== null) {
    const winnerPlayer = st.players[st.winner];
    const iWon = app.mode === 'local' ? true : st.winner === app.myIndex;
    document.getElementById('victory-title').textContent =
      app.mode === 'local'
        ? `Vince ${winnerPlayer.name}!`
        : iWon
          ? '🎉 Hai Vinto!'
          : `Ha vinto ${winnerPlayer.name}!`;
    document.getElementById('victory-subtitle').textContent =
      `${winnerPlayer.name} ha completato per primo tutti i numeri da 1 a 9!`;
    document.getElementById('stat-max-streak').textContent = Math.max(
      st.players[0].maxStreak,
      st.players[1].maxStreak
    );
    document.getElementById('stat-total-turns').textContent = st.totalDraws;
    victoryModal.classList.add('open');
  } else {
    victoryModal.classList.remove('open');
  }
}

function renderPlayerGrid(containerId, playerIndex) {
  const st = app.state;
  const container = document.getElementById(containerId);
  const board = st.players[playerIndex].board;
  const isTurnBoard = st.turn === playerIndex;

  container.innerHTML = '';

  for (let num = 1; num <= 9; num++) {
    const slot = document.createElement('div');
    slot.className = 'grid-slot';

    const placedCard = board[num];
    const canPlaceHere =
      isTurnBoard &&
      isMyTurnToAct() &&
      st.phase === 'PLACING' &&
      st.pendingCard &&
      st.pendingCard.number === num;

    const isDuplicateShake =
      isTurnBoard &&
      st.phase === 'DUPLICATE_WAIT' &&
      st.duplicateSlotNumber === num;

    if (canPlaceHere) {
      slot.classList.add('can-place');
      slot.addEventListener('click', () => requestPlaceCard(num));
    }

    if (isDuplicateShake) {
      slot.classList.add('duplicate-shake');
    }

    if (placedCard) {
      slot.innerHTML = renderUnoCardHTML(placedCard);
    } else {
      slot.innerHTML = `<span class="grid-slot-number">${num}</span>`;
    }

    container.appendChild(slot);
  }
}

function renderUnoCardHTML(card) {
  const tilt = card.tilt || 0;
  return `
    <div class="uno-card color-${card.color}" style="--card-tilt: ${tilt}deg;">
      <span class="uno-card-corner top-left">${card.number}</span>
      <span class="uno-card-center-num">${card.number}</span>
      <span class="uno-card-corner bottom-right">${card.number}</span>
    </div>
  `;
}

// ============================================================================
// CONDIVISIONE MOBILE NATIVA (WhatsApp / Share Sheet / QR Code)
// ============================================================================

function getShareableInviteUrl() {
  let base = window.location.href.split('?')[0].split('#')[0];
  if (app.lanOrigin && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) {
    base = `${app.lanOrigin}${window.location.pathname}`;
  }
  return `${base}?room=${app.roomCode}`;
}

async function shareInviteMobile() {
  if (!app.roomCode) return;
  const url = getShareableInviteUrl();
  const shareText = `🎴 Giochiamo a UNO Tabella 1-9! Entra nella mia stanza (Codice: ${app.roomCode}):`;

  if (navigator.share) {
    try {
      await navigator.share({
        title: 'UNO Tabella 1-9 Duel',
        text: shareText,
        url
      });
      return;
    } catch (_) {}
  }

  const waUrl = `https://wa.me/?text=${encodeURIComponent(`${shareText} ${url}`)}`;
  window.open(waUrl, '_blank');
}

function copyInviteLink() {
  if (!app.roomCode) return;
  const url = getShareableInviteUrl();
  navigator.clipboard.writeText(url).then(() => {
    const btn = document.getElementById('btn-copy-link');
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = '✅ Copiato!';
      setTimeout(() => (btn.textContent = orig), 1800);
    }
  });
}

function copyRoomCode() {
  if (!app.roomCode) return;
  navigator.clipboard.writeText(app.roomCode).then(() => {
    const btn = document.getElementById('btn-copy-code');
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = '✅ Copiato!';
      setTimeout(() => (btn.textContent = orig), 1800);
    }
  });
}

function getPlayerNameInput() {
  const val = document.getElementById('player-name-input').value.trim();
  return val || 'Giocatore 1';
}

function showLobbyError(msg) {
  const el = document.getElementById('lobby-error');
  el.textContent = msg;
  el.style.display = 'block';
}

function hideLobbyError() {
  document.getElementById('lobby-error').style.display = 'none';
}

function setConnectionStatus(connected) {
  const dot = document.getElementById('conn-dot');
  if (connected) {
    dot.classList.remove('waiting');
  } else {
    dot.classList.add('waiting');
  }
}

function enterGameScreen() {
  document.getElementById('lobby-screen').classList.remove('active');
  document.getElementById('game-screen').classList.add('active');
  document.getElementById('btn-leave').style.display = 'inline-flex';

  const pill = document.getElementById('room-pill');
  if (app.mode === 'online' && app.roomCode) {
    pill.style.display = 'inline-flex';
    document.getElementById('room-code-header').textContent = app.roomCode;
  } else {
    pill.style.display = 'none';
  }

  renderAll();
}

function spawnFloatingEmoji(emoji) {
  const el = document.createElement('div');
  el.className = 'floating-emoji';
  el.textContent = emoji;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1800);
}

window.addEventListener('DOMContentLoaded', () => {
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    fetch('/api/info')
      .then((r) => r.json())
      .then((info) => {
        if (info && info.lanOrigin) {
          app.lanOrigin = info.lanOrigin;
        }
      })
      .catch(() => {});
  }

  document.getElementById('btn-create-room').addEventListener('click', () => {
    sfx.init();
    hostOnlineRoom();
  });

  document.getElementById('btn-join-room').addEventListener('click', () => {
    sfx.init();
    const code = document.getElementById('join-code-input').value;
    joinOnlineRoom(code);
  });

  document.getElementById('join-code-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      sfx.init();
      joinOnlineRoom(e.target.value);
    }
  });

  document.getElementById('btn-local-mode').addEventListener('click', () => {
    sfx.init();
    app.mode = 'local';
    app.role = 'host';
    app.myIndex = 0;
    app.opponentConnected = true;
    const p1 = getPlayerNameInput();
    app.state = createInitialGameState(p1, 'Giocatore 2');
    enterGameScreen();
  });

  document.getElementById('btn-native-share').addEventListener('click', shareInviteMobile);
  document.getElementById('btn-copy-code').addEventListener('click', copyRoomCode);
  document.getElementById('btn-copy-link').addEventListener('click', copyInviteLink);
  document.getElementById('room-pill').addEventListener('click', shareInviteMobile);

  const bannerShareBtn = document.getElementById('btn-banner-share');
  if (bannerShareBtn) {
    bannerShareBtn.addEventListener('click', shareInviteMobile);
  }

  document.getElementById('uno-deck').addEventListener('click', handleDeckClick);

  document.getElementById('btn-rematch').addEventListener('click', () => {
    if (app.mode === 'online' && app.role === 'guest') {
      sendNetMessage('PLAYER_ACTION', { action: 'REMATCH' });
    } else {
      executeRematch();
    }
  });

  document.getElementById('btn-rules').addEventListener('click', () => {
    document.getElementById('rules-modal').classList.add('open');
  });
  document.getElementById('btn-close-rules').addEventListener('click', () => {
    document.getElementById('rules-modal').classList.remove('open');
  });

  document.getElementById('btn-sound').addEventListener('click', (e) => {
    sfx.enabled = !sfx.enabled;
    e.currentTarget.textContent = sfx.enabled ? '🔊' : '🔇';
  });

  document.getElementById('btn-leave').addEventListener('click', () => {
    window.location.href = window.location.pathname;
  });

  document.querySelectorAll('.emoji-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const emoji = btn.getAttribute('data-emoji');
      spawnFloatingEmoji(emoji);
      sendNetMessage('EMOJI_REACTION', { emoji });
    });
  });

  // Quando torni da WhatsApp al browser su mobile, recupera subito gli eventi Cloud e riattiva WebRTC!
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && app.mode === 'online' && app.roomCode) {
      pollCloudRelayOnce(app.roomCode);
      connectCloudRelay(app.roomCode);
      if (app.role === 'host') {
        if (!app.peer || app.peer.destroyed) {
          initHostPeer(app.roomCode);
        } else if (app.peer.disconnected) {
          try {
            app.peer.reconnect();
          } catch (_) {
            initHostPeer(app.roomCode);
          }
        }
        if (app.opponentConnected) {
          broadcastState();
        }
      } else if (app.role === 'guest' && !app.opponentConnected) {
        sendNetMessage('GUEST_JOINED', { guestName: getPlayerNameInput() });
      }
    }
  });

  // Se il giocatore apre il link di invito ?room=CODICE dallo smartphone, popola il codice
  const params = new URLSearchParams(window.location.search);
  const roomParam = params.get('room');
  if (roomParam) {
    document.getElementById('join-code-input').value = roomParam.toUpperCase();
    document.getElementById('player-name-input').value = 'Giocatore 2';
  }
});
