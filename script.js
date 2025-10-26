// script.js (Client-side)

// 定数定義
const CANVAS_SIZE = 800; // ゲーム画面サイズ
const LOBBY_CANVAS_SIZE = 600; // ロビー画面サイズ
const PLAYER_RADIUS = 20;
const BOSS_RADIUS = 50;
const AUTO_ATTACK_RANGE = 200; // 通常攻撃射程
const MOVE_DELAY = 33; // 移動入力の最小間隔 (ms)
const MOVE_THRESHOLD = 0.5; // ゲームパッドアナログスティックの閾値
// [追加] プレイヤーの初期スポーン座標 (ロビー画面中央: 300)
const PLAYER_SPAWN_CENTER_LOBBY = LOBBY_CANVAS_SIZE / 2;

// 職業ごとの設定
const JOB_DATA = {
    MELEE: {
        name: '近接アタッカー',
        color: '#F44336',
        description: '高耐久・高火力。ボスに密着して戦う。',
        autoAttackDamage: 5,
        skill1: { name: '突進', cd: 8000, range: 100 },
        skill2: { name: '防御', cd: 15000, duration: 3000 },
        super: { name: '大回転斬り', cd: 40000, range: 150 }
    },
    RANGED: {
        name: '遠距離アタッカー',
        color: '#2196F3',
        description: '遠距離から継続攻撃。紙耐久。',
        autoAttackDamage: 2,
        skill1: { name: '連射', cd: 5000, count: 3 },
        skill2: { name: '後退ジャンプ', cd: 12000, distance: 150 },
        super: { name: '超精密射撃', cd: 45000, damage: 500 }
    },
    HEALER: {
        name: 'ヒーラー',
        color: '#4CAF50',
        description: '味方を回復。攻撃力は低い。',
        autoAttackDamage: 1,
        skill1: { name: '単体回復', cd: 7000, range: 300, heal: 100 },
        skill2: { name: '加速フィールド', cd: 20000, range: 150, duration: 5000 },
        super: { name: '全体大回復', cd: 60000, heal: 300 }
    },
    SUPPORT: {
        name: 'サポーター',
        color: '#FF9800',
        description: 'デバフ/バフで味方を支援。',
        autoAttackDamage: 1,
        skill1: { name: '防御デバフ', cd: 10000, range: 250, duration: 8000 },
        skill2: { name: '攻撃バフ', cd: 18000, range: 200, duration: 5000 },
        super: { name: 'ボスタイムストップ', cd: 70000, duration: 4000 }
    }
};

// サーバーから受信するゲーム状態
let gameState = {
    players: {},
    boss: null,
    projectiles: [],
    bossAttacks: [],
    gameRunning: false,
    startTime: 0,
    countdown: 3
};

// 自身のクライアント情報
let game = {
    playerId: null,
    isHost: false,
    socket: null,
    currentScreen: 'title',
    lastMoveTime: 0,
    gamepadInterval: null,
    gameLoop: null,

    // Canvas/Context
    gameCanvas: null,
    gameCtx: null,
    lobbyCanvas: null,
    lobbyCtx: null,

    // オーディオ (前回の迷路ゲームの流用)
    audioCtx: null,
    masterGainNode: null,
    DEFAULT_VOLUME: 0.3,

    // ホスト設定
    bossMaxHp: 10000,
    bossDamageMultiplier: 1.0,
};

// キーボードの状態を管理するためのグローバル変数
let keysPressed = {};
const MOVEMENT_KEYS = ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];

// --- 初期化とイベント設定 ---
document.addEventListener('DOMContentLoaded', () => {
    game.gameCanvas = document.getElementById('game-canvas');
    game.gameCtx = game.gameCanvas.getContext('2d');
    game.lobbyCanvas = document.getElementById('lobby-canvas');
    game.lobbyCtx = game.lobbyCanvas.getContext('2d');

    setupEventListeners();
    initAudio();
    showScreen('title');
    startGamepadPolling();
});

function setupEventListeners() {
    // 接続・切断
    document.getElementById('create-room-button').addEventListener('click', () => showConnectionModal('host'));
    document.getElementById('join-room-button').addEventListener('click', () => showConnectionModal('guest'));
    document.getElementById('connect-submit').addEventListener('click', connectToServer);
    document.getElementById('connection-cancel').addEventListener('click', hideConnectionModal);
    document.getElementById('lobby-disconnect-button').addEventListener('click', disconnectServer);
    document.getElementById('back-to-title').addEventListener('click', disconnectServer);
    document.getElementById('back-to-select-clear').addEventListener('click', disconnectServer);

    // ホスト操作
    document.getElementById('start-game-button').addEventListener('click', sendStartGameRequest);

    // ホスト設定の更新
    const bossHpInput = document.getElementById('boss-hp');
    const bossHpValueSpan = document.getElementById('boss-hp-value');
    bossHpInput.addEventListener('input', (e) => {
        game.bossMaxHp = parseInt(e.target.value) * 1000;
        bossHpValueSpan.textContent = `${game.bossMaxHp.toLocaleString()} (x${e.target.value})`;
    });

    const bossDamageInput = document.getElementById('boss-damage');
    const bossDamageValueSpan = document.getElementById('boss-damage-value');
    bossDamageInput.addEventListener('input', (e) => {
        game.bossDamageMultiplier = parseFloat(e.target.value);
        bossDamageValueSpan.textContent = `${game.bossDamageMultiplier.toFixed(1)}倍`;
    });

    // 入力
    window.addEventListener("gamepadconnected", updateGamepadStatus);
    window.addEventListener("gamepaddisconnected", updateGamepadStatus);

    // キーボードの移動とアクション処理を分離
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
}

function initAudio() {
    const audioInitHandler = () => {
        if (!game.audioCtx) {
            try {
                game.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                game.masterGainNode = game.audioCtx.createGain();
                game.masterGainNode.connect(game.audioCtx.destination);
                game.masterGainNode.gain.setValueAtTime(game.DEFAULT_VOLUME, game.audioCtx.currentTime);
            } catch (e) {
                console.warn('Web Audio APIはサポートされていません:', e);
                return;
            }
        }

        if (game.audioCtx.state === 'suspended') {
            game.audioCtx.resume();
        }

        document.removeEventListener('click', audioInitHandler);
        document.removeEventListener('keydown', audioInitHandler);
    };

    document.addEventListener('click', audioInitHandler);
    document.addEventListener('keydown', audioInitHandler);
}

function playSound(type) {
    if (!game.audioCtx || !game.masterGainNode) return;
    const oscillator = game.audioCtx.createOscillator();
    const soundGainNode = game.audioCtx.createGain();
    oscillator.connect(soundGainNode);
    soundGainNode.connect(game.masterGainNode);

    let freq, duration, initialVolume;

    switch (type) {
        case 'move': freq = 440; duration = 0.05; initialVolume = 0.1; break;
        case 'hit': freq = 120; duration = 0.1; initialVolume = 0.3; break;
        case 'attack': freq = 880; duration = 0.02; initialVolume = 0.2; break;
        case 'skill': freq = 1300; duration = 0.1; initialVolume = 0.4; break;
        case 'damage': freq = 60; duration = 0.2; initialVolume = 0.6; break;
        case 'win': freq = 1000; duration = 0.5; initialVolume = 0.4; break;
        case 'lose': freq = 50; duration = 1.0; initialVolume = 0.6; break;
        default: return;
    }

    oscillator.frequency.setValueAtTime(freq, game.audioCtx.currentTime);
    soundGainNode.gain.setValueAtTime(initialVolume, game.audioCtx.currentTime);

    oscillator.start();
    soundGainNode.gain.exponentialRampToValueAtTime(0.001, game.audioCtx.currentTime + duration);
    oscillator.stop(game.audioCtx.currentTime + duration);
}

// --- UI/画面管理 ---
function showScreen(screenName) {
    document.querySelectorAll('.screen').forEach(screen => screen.classList.remove('active'));
    const screenElement = document.getElementById(`${screenName}-screen`);
    if (screenElement) screenElement.classList.add('active');
    game.currentScreen = screenName;

    // 💡 修正: game.gameLoop を使用
    if (game.gameLoop) {
        clearInterval(game.gameLoop);
        game.gameLoop = null;
    }

    if (screenName === 'lobby') {
        renderLobby();
        game.gameLoop = setInterval(renderLobby, 1000 / 30); // ロビー描画ループ
    } else if (screenName === 'game') {
        game.gameLoop = setInterval(gameRenderLoop, 1000 / 60); // ゲーム描画ループ
        document.getElementById('game-canvas').focus();
    } else if (screenName === 'title') {
        document.getElementById('create-room-button').focus();
    }
}

function showConnectionModal(type) {
    const modal = document.getElementById('connection-modal');
    const title = document.getElementById('connection-title');
    const submitButton = document.getElementById('connect-submit');
    const addressInput = document.getElementById('server-address');

    game.isHost = (type === 'host');
    title.textContent = game.isHost ? '部屋を作成 (ホスト)' : '部屋に参加 (ゲスト)';
    submitButton.textContent = game.isHost ? '部屋を作成' : '接続して参加';

    if (game.isHost) {
        addressInput.value = addressInput.value || 'localhost:8080';
    } else if (!addressInput.value) {
        addressInput.value = '';
    }

    document.getElementById('title-screen').classList.remove('active');
    modal.classList.add('active');
    addressInput.focus();
}

function hideConnectionModal() {
    document.getElementById('connection-modal').classList.remove('active');
    document.getElementById('title-screen').classList.add('active');
}

// --- 通信処理 ---
function connectToServer() {
    const address = document.getElementById('server-address').value.trim();
    const parts = address.split(':');
    let ip = '';
    let port = '';

    if (parts.length === 2 && parts[1].length > 0 && !isNaN(parseInt(parts[1]))) {
        ip = parts[0];
        port = parts[1];
    } else if (parts.length === 1) {
        ip = parts[0];
        port = '443';
    } else {
        alert('接続アドレスは「ホスト名:ポート番号」または「ホスト名」の形式で入力してください。');
        return;
    }

    if (game.socket) game.socket.close();

    const isSecureHost = ip !== 'localhost' && ip !== '127.0.0.1';
    const protocol = isSecureHost ? 'wss' : 'ws';

    let url;

    if (isSecureHost && (port === '443' || parts.length === 1)) {
        url = `${protocol}://${ip}`;
    }
    else if (!isSecureHost && (port === '80' || parts.length === 1)) {
        url = `${protocol}://${ip}`;
    }
    else {
        url = `${protocol}://${ip}:${port}`;
    }

    game.socket = new WebSocket(url);

    game.socket.onopen = () => {
        console.log('サーバーに接続しました。');
        hideConnectionModal();
        document.getElementById('connection-status').textContent = '接続中...';
        document.getElementById('connection-status').style.color = '#FF9800';

        if (game.isHost) {
            game.socket.send(JSON.stringify({
                type: 'CREATE_ROOM',
                bossMaxHp: game.bossMaxHp,
                bossDamageMultiplier: game.bossDamageMultiplier
            }));
        } else {
            game.socket.send(JSON.stringify({ type: 'JOIN_ROOM' }));
        }
    };

    game.socket.onmessage = (event) => {
        handleServerMessage(JSON.parse(event.data));
    };

    game.socket.onerror = (e) => {
        console.error('WebSocketエラー:', e);
        document.getElementById('connection-status').textContent = '接続失敗';
        document.getElementById('connection-status').style.color = '#F44336';
        game.socket = null;
        alert('サーバーへの接続に失敗しました。');
        showScreen('title');
    };

    game.socket.onclose = () => {
        console.log('サーバーとの接続が切れました。');
        game.socket = null;
        if (game.currentScreen === 'game' || game.currentScreen === 'lobby') {
            alert('サーバーとの接続が切れました。タイトルに戻ります。');
        }
        showScreen('title');
    };
}

function disconnectServer() {
    if (game.socket) {
        game.socket.close();
    }
    gameState.gameRunning = false;
    showScreen('title');
}

function sendStartGameRequest() {
    if (game.socket && game.socket.readyState === WebSocket.OPEN && game.isHost) {
        game.socket.send(JSON.stringify({
            type: 'START_GAME'
        }));
        document.getElementById('start-game-button').disabled = true;
        document.getElementById('lobby-message').textContent = "ゲーム開始要求を送信しました...";
    }
}

function sendAction(actionType, payload = {}) {
    if (game.socket && game.socket.readyState === WebSocket.OPEN && game.playerId) {
        game.socket.send(JSON.stringify({
            type: actionType,
            ...payload
        }));
        if (actionType === 'MOVE') {
            playSound('move');
        } else if (actionType.startsWith('SKILL')) {
            playSound('skill');
        } else if (actionType === 'JOB_SELECT') {
            playSound('skill'); // 転職音
        }
    }
}


function handleServerMessage(data) {
    switch (data.type) {
        case 'ROOM_READY':
            game.playerId = data.yourId;
            gameState.players = data.players; // 自身の初期情報を受け取る

            document.getElementById('host-settings-panel').style.display = game.isHost ? 'block' : 'none';

            showScreen('lobby');
            updateLobbyStatus(data.players);
            break;

        case 'LOBBY_UPDATE':
            gameState.players = data.players;
            updateLobbyStatus(data.players);
            break;

        case 'GAME_START':
            gameState.players = data.players;
            gameState.boss = data.boss;
            gameState.gameRunning = true;
            gameState.startTime = Date.now();
            showScreen('game');
            // 開始直後の状態をリセット
            gameState.projectiles = [];
            gameState.bossAttacks = [];
            break;

        case 'GAME_STATE_UPDATE':
            // サーバーから送られてきた状態をマージ
            Object.assign(gameState.players, data.players);
            gameState.boss = data.boss;
            gameState.projectiles = data.projectiles;
            gameState.bossAttacks = data.bossAttacks;
            gameState.gameRunning = data.gameRunning;

            // UIの更新
            document.getElementById('boss-hp-display').textContent = `${gameState.boss.hp.toLocaleString()} / ${gameState.boss.maxHp.toLocaleString()}`;
            break;

        case 'GAME_OVER':
            // WIN/LOSE
            gameState.gameRunning = false;
            completeLevel(data.result, data.stats);
            break;

        case 'ERROR':
            alert(`エラー: ${data.message}`);
            disconnectServer();
            break;
    }
}

// --- ロビー画面の描画と管理 ---
const JOB_AREAS = {
    MELEE: { x: LOBBY_CANVAS_SIZE * 0.2, y: LOBBY_CANVAS_SIZE * 0.5, radius: 50 },
    RANGED: { x: LOBBY_CANVAS_SIZE * 0.8, y: LOBBY_CANVAS_SIZE * 0.5, radius: 50 },
    HEALER: { x: LOBBY_CANVAS_SIZE * 0.5, y: LOBBY_CANVAS_SIZE * 0.2, radius: 50 },
    SUPPORT: { x: LOBBY_CANVAS_SIZE * 0.5, y: LOBBY_CANVAS_SIZE * 0.8, radius: 50 }
};

function renderLobby() {
    const ctx = game.lobbyCtx;
    const canvas = game.lobbyCanvas;
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const myPlayer = gameState.players[game.playerId];

    // ダミー敵 (中央)
    drawCircle(ctx, canvas.width / 2, canvas.height / 2, BOSS_RADIUS, 'gray', 'white');

    // 職業選択エリア
    let currentOverlapJob = null;
    Object.keys(JOB_AREAS).forEach(jobKey => {
        const area = JOB_AREAS[jobKey];
        const job = JOB_DATA[jobKey];

        // 転職サークル
        drawCircle(ctx, area.x, area.y, area.radius, job.color, job.color + '50');

        // 職業名テキスト
        ctx.fillStyle = 'white';
        ctx.font = '16px Arial';
        ctx.textAlign = 'center';
        ctx.fillText(job.name, area.x, area.y + area.radius + 20);

        // 自身のプレイヤーとエリアの距離判定
        if (myPlayer) {
            const dist = Math.sqrt(Math.pow(myPlayer.x - area.x, 2) + Math.pow(myPlayer.y - area.y, 2));
            if (dist < PLAYER_RADIUS + area.radius) {
                currentOverlapJob = jobKey;
                // インタラクトUI表示 (自機中心)
                ctx.fillStyle = 'white';
                ctx.fillRect(myPlayer.x - 100, myPlayer.y - 150, 200, 140);
                
                ctx.fillStyle = 'black';
                ctx.font = '16px Arial';
                ctx.textAlign = 'center';
                ctx.fillText(`[E] で ${job.name} に転職`, myPlayer.x, myPlayer.y - 130);
                
                ctx.font = '14px Arial';
                ctx.fillText(job.description, myPlayer.x, myPlayer.y - 100);
            }
        }
    });

    // プレイヤーを描画
    Object.values(gameState.players).forEach(p => {
        if (!p) return;
        drawPlayer(ctx, p, p.color);

        // プレイヤーIDと職業名
        ctx.fillStyle = 'white';
        ctx.font = '12px Arial';
        ctx.textAlign = 'center';
        ctx.fillText(p.id + (p.job ? ` (${JOB_DATA[p.job].name})` : '[未選択]'), p.x, p.y + PLAYER_RADIUS + 15);

        // 自身の場合、オートアタック範囲を表示
        if (p.id === game.playerId && p.job) {
            drawAutoAttackRange(ctx, p, true);
        }
    });

    // プレイヤーが現在接触しているジョブを保存
    if (myPlayer) {
        myPlayer.overlapJob = currentOverlapJob;
    }
}

function updateLobbyStatus(playersData) {
    const playerList = document.getElementById('lobby-player-list');
    const startButton = document.getElementById('start-game-button');
    const lobbyMessage = document.getElementById('lobby-message');
    const playerIds = Object.keys(playersData).sort();
    const playerCount = playerIds.length;

    playerList.innerHTML = `<h4>参加プレイヤー (${playerCount}人):</h4>`;
    
    playerIds.forEach(id => {
        const isMe = id === game.playerId;
        const player = playersData[id];
        if (!player) return;

        const playerDiv = document.createElement('p');
        playerDiv.style.color = player.color;
        playerDiv.style.fontWeight = 'bold';
        playerDiv.textContent = `▶︎ ${id} ${isMe ? '(あなた)' : ''} ${player.job ? `[${JOB_DATA[player.job].name}]` : '[未選択]'}`;
        playerList.appendChild(playerDiv);
    });

    if (game.isHost) {
        if (playerCount >= 1) { // 1人でもデバッグできるように
            startButton.style.display = 'block';
            startButton.disabled = false;
            lobbyMessage.textContent = "準備完了！[ゲーム開始] または [Enter] キーを押してください。";
        } else {
            startButton.style.display = 'none';
            lobbyMessage.textContent = "他のプレイヤーの参加を待っています...";
        }
    } else {
        startButton.style.display = 'none';
        lobbyMessage.textContent = "ホストの操作を待っています...";
    }
}

// ロビーで [E] キーが押されたときにジョブ選択を試みる
function attemptJobSelect() {
    const myPlayer = gameState.players[game.playerId];
    if (myPlayer && myPlayer.overlapJob) {
        sendAction('JOB_SELECT', { job: myPlayer.overlapJob });
    }
}


// --- 入力処理 (修正・追加) ---

/**
 * キーボードとゲームパッドの入力を処理し、サーバーに移動アクションを送信する
 */
function handleMovementInput() {
    if (game.currentScreen !== 'lobby' && game.currentScreen !== 'game') return;
    if (Date.now() < game.lastMoveTime + MOVE_DELAY) return;

    let dx = 0;
    let dy = 0;

    // 1. キーボード入力
    if (keysPressed['KeyW'] || keysPressed['ArrowUp']) dy -= 1;
    if (keysPressed['KeyS'] || keysPressed['ArrowDown']) dy += 1;
    if (keysPressed['KeyA'] || keysPressed['ArrowLeft']) dx -= 1;
    if (keysPressed['KeyD'] || keysPressed['ArrowRight']) dx += 1;

    // 2. ゲームパッド入力
    const gamepad = navigator.getGamepads()[0];
    if (gamepad) {
        // アナログスティック (左スティック: Axes 0, 1)
        const axesX = gamepad.axes[0];
        const axesY = gamepad.axes[1];

        if (Math.abs(axesX) > MOVE_THRESHOLD) dx += axesX;
        if (Math.abs(axesY) > MOVE_THRESHOLD) dy += axesY;
        
        // 十字キー/方向ボタン (Buttons 12, 13, 14, 15)
        if (gamepad.buttons[12]?.pressed) dy -= 1; // Up
        if (gamepad.buttons[13]?.pressed) dy += 1; // Down
        if (gamepad.buttons[14]?.pressed) dx -= 1; // Left
        if (gamepad.buttons[15]?.pressed) dx += 1; // Right

        // スキル/攻撃ボタンもここで処理 (ゲーム中のみ)
        if (game.currentScreen === 'game' && gameState.gameRunning) {
            // A/X ボタン (Index 0) - オートアタック
            if (gamepad.buttons[0]?.pressed) sendAction('AUTO_ATTACK');
            // B/O ボタン (Index 1) - スキル1
            if (gamepad.buttons[1]?.pressed) sendAction('SKILL_1');
            // Y/△ ボタン (Index 3) - スキル2
            if (gamepad.buttons[3]?.pressed) sendAction('SKILL_2');
            // X/□ ボタン (Index 2) - スーパー
            if (gamepad.buttons[2]?.pressed) sendAction('SUPER');
        }
    }

    // 3. 移動の正規化と送信
    if (dx !== 0 || dy !== 0) {
        // 正規化 (斜め移動の速度を抑える)
        const magnitude = Math.sqrt(dx * dx + dy * dy);
        const normalizedDx = dx / magnitude;
        const normalizedDy = dy / magnitude;

        sendAction('MOVE', { dx: normalizedDx, dy: normalizedDy });
        game.lastMoveTime = Date.now();
    }
}


/**
 * キーダウンイベントハンドラ (移動キーの状態記録とアクションキーの即時処理)
 * @param {KeyboardEvent} event 
 */
function handleKeyDown(event) {
    // ロビー画面での Enter キーによるゲーム開始
    if (game.currentScreen === 'lobby' && game.isHost && event.code === 'Enter') {
        const startButton = document.getElementById('start-game-button');
        if (startButton && startButton.style.display !== 'none' && !startButton.disabled) {
            sendStartGameRequest();
        }
        event.preventDefault();
        return;
    }

    // ロビーでの転職
    if (event.code === 'KeyE' && game.currentScreen === 'lobby') {
        attemptJobSelect();
        event.preventDefault();
        return;
    }

    // 移動キーの状態記録 (ロビー/ゲーム共通)
    if (MOVEMENT_KEYS.includes(event.code)) {
        keysPressed[event.code] = true;
    }
    
    // ゲーム中のスキル発動
    if (game.currentScreen === 'game' && gameState.gameRunning) {
        if (event.code === 'Space') {
            sendAction('AUTO_ATTACK'); // 通常攻撃
            event.preventDefault();
        } else if (event.code === 'KeyQ') {
            sendAction('SKILL_1');
            event.preventDefault();
        } else if (event.code === 'KeyR') {
            sendAction('SKILL_2');
            event.preventDefault();
        } else if (event.code === 'KeyF') {
            sendAction('SUPER');
            event.preventDefault();
        }
    }
}

/**
 * キーアップイベントハンドラ (移動キーの状態解除)
 * @param {KeyboardEvent} event 
 */
function handleKeyUp(event) {
    if (MOVEMENT_KEYS.includes(event.code)) {
        keysPressed[event.code] = false;
    }
}

/**
 * ゲームパッドとキーボードのポーリングを開始する
 */
function startGamepadPolling() {
    if (game.gamepadInterval) clearInterval(game.gamepadInterval);
    
    // MOVE_DELAYと同じ頻度で移動入力を処理することで、滑らかな動きを実現
    game.gamepadInterval = setInterval(handleMovementInput, MOVE_DELAY); 

    // ゲームパッドの状態表示を更新するロジック
    setInterval(() => {
        const gamepad = navigator.getGamepads()[0];
        const statusElement = document.getElementById('gamepad-status');
        if (statusElement) {
            if (gamepad) {
                statusElement.textContent = `コントローラー: ${gamepad.id} 接続済み`;
                statusElement.style.color = '#4CAF50';
            } else {
                statusElement.textContent = 'コントローラー: 未接続 (キーボード操作)';
                statusElement.style.color = '#FF9800';
            }
        }
    }, 500);
}

function updateGamepadStatus() {
    // Gamepad接続/切断イベント発生時にコンソールに出力
    const gamepads = navigator.getGamepads();
    if (gamepads.length > 0 && gamepads[0]) {
        console.log("Gamepad connected at index %d: %s. %d buttons, %d axes.",
                    gamepads[0].index, gamepads[0].id,
                    gamepads[0].buttons.length, gamepads[0].axes.length);
    } else {
        console.log("Gamepad disconnected.");
    }
    // startGamepadPollingが既に実行されているため、ここでは特別な処理は不要
}

// --- ゲーム画面の描画 ---
function gameRenderLoop() {
    // 描画がロビー/ゲームで異なるため、現在の状態に応じて処理を分ける
    if (game.currentScreen === 'game') {
        renderGame();
    } else if (game.currentScreen === 'lobby') {
        renderLobby();
    }
}

function renderGame() {
    const ctx = game.gameCtx;
    const canvas = game.gameCanvas;
    const myPlayer = gameState.players[game.playerId];
    if (!ctx || !myPlayer) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 画面の中心をプレイヤーに合わせるためのオフセット計算
    const offsetX = canvas.width / 2 - myPlayer.x;
    const offsetY = canvas.height / 2 - myPlayer.y;

    // Bossの描画
    if (gameState.boss) {
        drawBoss(ctx, gameState.boss, offsetX, offsetY);
    }

    // Projectileの描画
    gameState.projectiles.forEach(p => {
        drawProjectile(ctx, p, offsetX, offsetY);
    });

    // Boss Attackの描画
    gameState.bossAttacks.forEach(a => {
        drawBossAttack(ctx, a, offsetX, offsetY);
    });

    // プレイヤーの描画
    Object.values(gameState.players).forEach(p => {
        drawPlayer(ctx, p, p.color, offsetX, offsetY);

        // HPバー
        const hpY = p.y - PLAYER_RADIUS - 15 + offsetY;
        const hpX = p.x + offsetX; // HPバーはプレイヤーの中心に合わせる
        drawHealthBar(ctx, hpX, hpY, p.hp / p.maxHp, p.id === game.playerId);
    });

    // 自身のプレイヤー情報UIの更新
    updateGameUI(myPlayer);
}

function updateGameUI(player) {
    // プレイヤーのHPとCOOLDOWN表示など
    const hpElement = document.getElementById('player-hp-display');
    const cdElement = document.getElementById('player-cooldowns');

    if (hpElement) {
        hpElement.textContent = `HP: ${player.hp} / ${player.maxHp}`;
        hpElement.style.color = player.hp < player.maxHp * 0.3 ? '#F44336' : '#4CAF50';
    }

    if (cdElement) {
        const now = Date.now();
        let html = '';
        if (player.job) {
            // スキル1
            const skill1CD = player.skill1.nextCastTime - now;
            const skill1Name = JOB_DATA[player.job].skill1.name;
            const skill1CDTime = Math.max(0, Math.ceil(skill1CD / 1000));
            html += `<p>Q: ${skill1Name} (${skill1CDTime}s)</p>`;

            // スキル2
            const skill2CD = player.skill2.nextCastTime - now;
            const skill2Name = JOB_DATA[player.job].skill2.name;
            const skill2CDTime = Math.max(0, Math.ceil(skill2CD / 1000));
            html += `<p>R: ${skill2Name} (${skill2CDTime}s)</p>`;

            // スーパー
            const superCD = player.super.nextCastTime - now;
            const superName = JOB_DATA[player.job].super.name;
            const superCDTime = Math.max(0, Math.ceil(superCD / 1000));
            html += `<p>F: ${superName} (${superCDTime}s)</p>`;
        } else {
            html += '<p>職業を選択してください</p>';
        }
        cdElement.innerHTML = html;
    }
}

// --- 描画ユーティリティ ---

function drawCircle(ctx, x, y, r, fillColor, strokeColor) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = fillColor;
    ctx.fill();
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 3;
    ctx.stroke();
}

function drawPlayer(ctx, p, color, offsetX = 0, offsetY = 0) {
    const drawX = p.x + offsetX;
    const drawY = p.y + offsetY;

    // プレイヤー本体
    drawCircle(ctx, drawX, drawY, PLAYER_RADIUS, color, 'white');

    // 職業マーク (ロビーでは表示しない)
    if (p.job && game.currentScreen === 'game') {
        const job = JOB_DATA[p.job];
        ctx.fillStyle = 'white';
        ctx.font = '12px Arial';
        ctx.textAlign = 'center';
        ctx.fillText(job.name.substring(0, 1), drawX, drawY + 4);
    }
}

function drawBoss(ctx, boss, offsetX, offsetY) {
    const drawX = boss.x + offsetX;
    const drawY = boss.y + offsetY;

    // ボス本体
    drawCircle(ctx, drawX, drawY, BOSS_RADIUS, '#8B0000', '#F44336');

    // HPバー
    const hpY = drawY - BOSS_RADIUS - 10;
    const hpX = drawX;
    drawHealthBar(ctx, hpX, hpY, boss.hp / boss.maxHp, false, 150, 15);
}

function drawProjectile(ctx, p, offsetX, offsetY) {
    const drawX = p.x + offsetX;
    const drawY = p.y + offsetY;

    drawCircle(ctx, drawX, drawY, p.radius, p.color, p.color);
}

function drawBossAttack(ctx, a, offsetX, offsetY) {
    if (a.type === 'AOE') {
        ctx.beginPath();
        ctx.arc(a.x + offsetX, a.y + offsetY, a.radius, 0, Math.PI * 2);
        ctx.fillStyle = a.warning ? 'rgba(255, 0, 0, 0.3)' : 'rgba(255, 0, 0, 0.8)';
        ctx.fill();
        ctx.strokeStyle = a.warning ? 'red' : 'white';
        ctx.lineWidth = 2;
        ctx.stroke();

        // 警告タイマー
        if (a.warning && a.damageTime) {
            const timeLeft = Math.ceil((a.damageTime - Date.now()) / 1000);
            if (timeLeft > 0) {
                ctx.fillStyle = 'white';
                ctx.font = '30px Arial';
                ctx.textAlign = 'center';
                ctx.fillText(timeLeft, a.x + offsetX, a.y + offsetY + 10);
            }
        }
    }
    // 他の攻撃タイプは省略
}

function drawAutoAttackRange(ctx, p, isLobby = false, offsetX = 0, offsetY = 0) {
    const drawX = p.x + offsetX;
    const drawY = p.y + offsetY;

    ctx.beginPath();
    ctx.arc(drawX, drawY, AUTO_ATTACK_RANGE, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.lineWidth = 1;
    ctx.stroke();

    if (isLobby) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
        ctx.fill();
    }
}

function drawHealthBar(ctx, x, y, percent, isMe, width = 60, height = 8) {
    const color = isMe ? '#4CAF50' : (percent < 0.3 ? '#F44336' : '#FFEB3B');

    // 背景
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(x - width / 2, y, width, height);

    // HPゲージ本体
    ctx.fillStyle = color;
    ctx.fillRect(x - width / 2, y, width * percent, height);

    ctx.strokeStyle = '#111';
    ctx.lineWidth = 1;
    ctx.strokeRect(x - width / 2, y, width, height);
}


// --- リザルト画面 ---
function completeLevel(result, stats) {
    playSound(result === 'WIN' ? 'win' : 'lose');

    const title = document.getElementById('result-title');
    const message = document.getElementById('result-message');
    const resultTableBody = document.querySelector('#result-table tbody');

    if (result === 'WIN') {
        title.textContent = '🏆 勝利！';
        message.textContent = 'ボスを討伐しました！';
        title.style.color = '#4CAF50';
    } else {
        title.textContent = '💀 敗北...';
        message.textContent = '全滅しました。';
        title.style.color = '#F44336';
    }

    // テーブルの更新
    resultTableBody.innerHTML = '';
    Object.values(stats).forEach(playerStat => {
        const row = resultTableBody.insertRow();
        const jobName = playerStat.job ? JOB_DATA[playerStat.job].name : '未選択';

        row.insertCell().textContent = playerStat.id;
        row.insertCell().textContent = jobName;
        row.insertCell().textContent = playerStat.deaths;
        row.insertCell().textContent = playerStat.damageDealt.toLocaleString();
        row.insertCell().textContent = playerStat.healDone.toLocaleString();
    });

    showScreen('result');
}