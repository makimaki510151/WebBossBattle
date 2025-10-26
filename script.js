// script.js (Client-side)

// 定数定義
const CANVAS_SIZE = 800; // ゲーム画面サイズ
const LOBBY_CANVAS_SIZE = 600; // ロビー画面サイズ
const PLAYER_RADIUS = 20;
const BOSS_RADIUS = 50;
const AUTO_ATTACK_RANGE = 200; // 通常攻撃射程
const MOVE_DELAY = 100; // 移動入力の最小間隔 (ms)
const MOVE_THRESHOLD = 0.5; // ゲームパッドアナログスティックの閾値

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
    gameLoop: null, // 💡 修正: gameLoopをgameオブジェクトのプロパティとして定義
    
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
    window.addEventListener('keydown', handleKeyboardInput);
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
        game.gameLoop = setInterval(renderLobby, 1000/30); // ロビー描画ループ
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
        drawPlayer(ctx, p, p.color);
        
        // プレイヤーIDと職業名
        ctx.fillStyle = 'white';
        ctx.font = '12px Arial';
        ctx.textAlign = 'center';
        ctx.fillText(p.id + (p.job ? ` (${JOB_DATA[p.job].name})` : ''), p.x, p.y + PLAYER_RADIUS + 15);

        // 自身の場合、オートアタック範囲を表示
        if (p.id === game.playerId && p.job) {
             drawAutoAttackRange(ctx, p, true);
        }
    });
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
    } 
    else {
        startButton.style.display = 'none';
        lobbyMessage.textContent = "ホストの操作を待っています...";
    }
}


// --- 入力処理 ---
function handleKeyboardInput(event) {
    // ロビー画面での Enter キーによるゲーム開始
    if (game.currentScreen === 'lobby' && game.isHost && event.code === 'Enter') {
        const startButton = document.getElementById('start-game-button');
        if (startButton && startButton.style.display !== 'none' && !startButton.disabled) {
            sendStartGameRequest();
        }
        event.preventDefault();
        return;
    }

    if (game.currentScreen === 'lobby') {
        // ロビーでの移動と転職
        let dx = 0, dy = 0;
        switch (event.code) {
            case 'KeyW': case 'ArrowUp': dy = -1; break;
            case 'KeyS': case 'ArrowDown': dy = 1; break;
            case 'KeyA': case 'ArrowLeft': dx = -1; break;
            case 'KeyD': case 'ArrowRight': dx = 1; break;
            case 'KeyE': 
                attemptJobSelect();
                event.preventDefault();
                return;
            default: return;
        }
        event.preventDefault();
        const now = Date.now();
        if (now - game.lastMoveTime < MOVE_DELAY) return;
        game.lastMoveTime = now;
        
        sendAction('MOVE_LOBBY', { dx: dx * 10, dy: dy * 10 });

    } else if (game.currentScreen === 'game' && gameState.gameRunning) {
        // ゲーム中の移動とスキル発動
        const myPlayer = gameState.players[game.playerId];
        if (!myPlayer || myPlayer.isDead) return;

        let dx = 0, dy = 0;
        let actionType = null;

        switch (event.code) {
            case 'KeyW': case 'ArrowUp': dy = -1; break;
            case 'KeyS': case 'ArrowDown': dy = 1; break;
            case 'KeyA': case 'ArrowLeft': dx = -1; break;
            case 'KeyD': case 'ArrowRight': dx = 1; break;
            case 'Digit1': actionType = 'SKILL1'; break;
            case 'Digit2': actionType = 'SKILL2'; break;
            case 'Digit3': actionType = 'SUPER'; break;
            default: return;
        }
        event.preventDefault(); 
        
        if (actionType) {
            sendAction(actionType);
            return;
        }

        const now = Date.now();
        if (now - game.lastMoveTime < MOVE_DELAY) return;
        game.lastMoveTime = now;

        sendAction('MOVE', { dx: dx * 10, dy: dy * 10 });
    }
}

function attemptJobSelect() {
    const myPlayer = gameState.players[game.playerId];
    if (!myPlayer) return;

    for (const jobKey in JOB_AREAS) {
        const area = JOB_AREAS[jobKey];
        const dist = Math.sqrt(Math.pow(myPlayer.x - area.x, 2) + Math.pow(myPlayer.y - area.y, 2));
        
        if (dist < PLAYER_RADIUS + area.radius) {
            sendAction('JOB_SELECT', { job: jobKey });
            break;
        }
    }
}

function startGamepadPolling() {
    if (game.gamepadInterval) return;
    game.gamepadInterval = setInterval(pollGamepads, 1000 / 60); 
}

function updateGamepadStatus() {
    const gamepads = navigator.getGamepads();
    let connectedCount = 0;
    for (let i = 0; i < gamepads.length; i++) {
        if (gamepads[i]) connectedCount++;
    }

    let statusText = `${connectedCount}台のコントローラーが接続されています。`;
    document.getElementById('gamepad-status').textContent = statusText;
    document.getElementById('gamepad-status').style.color = connectedCount > 0 ? '#4CAF50' : '#F44336';
}

function pollGamepads() {
    const gamepads = navigator.getGamepads();
    const now = Date.now();
    const gamepad = gamepads[0];
    if (!gamepad) return;

    // ゲームパッドによるアクション
    if (game.currentScreen === 'game' && gameState.gameRunning) {
        const myPlayer = gameState.players[game.playerId];
        if (!myPlayer || myPlayer.isDead) return;

        // ボタン: X=0, A=1, B=2, Y=3, L1=4, R1=5, L2=6, R2=7
        if (gamepad.buttons[4]?.pressed) sendAction('SKILL1');
        if (gamepad.buttons[5]?.pressed) sendAction('SKILL2');
        if (gamepad.buttons[7]?.pressed) sendAction('SUPER');
    }
    
    // ゲームパッドによる移動
    if (now - game.lastMoveTime < MOVE_DELAY) return;

    let dx = 0, dy = 0;

    // 十字キー
    if (gamepad.buttons[12]?.pressed) dy = -1; // 上
    else if (gamepad.buttons[13]?.pressed) dy = 1; // 下
    else if (gamepad.buttons[14]?.pressed) dx = -1; // 左
    else if (gamepad.buttons[15]?.pressed) dx = 1; // 右
    
    // 左スティック
    const axisX = gamepad.axes[0] || 0;
    const axisY = gamepad.axes[1] || 0;

    if (dx === 0 && dy === 0) {
        if (axisY < -MOVE_THRESHOLD) dy = -1; 
        else if (axisY > MOVE_THRESHOLD) dy = 1; 
        else if (axisX < -MOVE_THRESHOLD) dx = -1; 
        else if (axisX > MOVE_THRESHOLD) dx = 1; 
    }

    if (dx !== 0 || dy !== 0) {
        game.lastMoveTime = now;
        
        if (game.currentScreen === 'lobby') {
            sendAction('MOVE_LOBBY', { dx: dx * 10, dy: dy * 10 });
        } else if (game.currentScreen === 'game' && gameState.gameRunning) {
            sendAction('MOVE', { dx: dx * 10, dy: dy * 10 });
        }
    }
}


// --- ゲーム画面の描画 ---
function gameRenderLoop() {
    if (game.currentScreen !== 'game' || !game.gameCtx) return;

    const ctx = game.gameCtx;
    const canvas = game.gameCanvas;

    // 1. 背景描画
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    if (!gameState.gameRunning) {
        // カウントダウン表示
        const elapsedTime = Date.now() - gameState.startTime;
        const remainingSeconds = gameState.countdown - Math.floor(elapsedTime / 1000);
        
        ctx.fillStyle = 'white';
        ctx.font = '80px Arial';
        ctx.textAlign = 'center';
        ctx.fillText(remainingSeconds > 0 ? remainingSeconds : 'FIGHT!', canvas.width / 2, canvas.height / 2);
        
        if (remainingSeconds <= 0) {
            // カウントダウン終了で強制的にゲームループを再開
            // サーバー側で'GAME_START'が送られるので、ここは描画用
        }
    }
    
    // 2. ボス攻撃範囲描画 (ゲージ付き)
    gameState.bossAttacks.forEach(attack => {
        const { x, y, radius, type, damageTime, duration } = attack;
        const gaugeRatio = Math.min(1, (Date.now() - damageTime) / duration);
        const color = gaugeRatio < 1 ? 'rgba(255, 0, 0, 0.3)' : 'rgba(255, 0, 0, 0.8)';
        
        // 円形攻撃
        if (type === 'CIRCLE') {
            drawCircle(ctx, x, y, radius, color, color);
            // ゲージ (円の中心から外へ)
            ctx.beginPath();
            ctx.arc(x, y, radius * gaugeRatio, 0, Math.PI * 2);
            ctx.strokeStyle = 'white';
            ctx.lineWidth = 3;
            ctx.stroke();
        }
        // 他の攻撃タイプ (帯、直線など) も追加可能
    });

    // 3. ボス描画
    if (gameState.boss) {
        drawCircle(ctx, gameState.boss.x, gameState.boss.y, BOSS_RADIUS, 'darkred', 'red');
        drawHealthBar(ctx, gameState.boss.x, gameState.boss.y - BOSS_RADIUS - 10, BOSS_RADIUS * 2, 10, gameState.boss.hp, gameState.boss.maxHp, 'red');
        
        // ボス名
        ctx.fillStyle = 'white';
        ctx.font = '20px Arial';
        ctx.textAlign = 'center';
        ctx.fillText('THE ABYSSAL KNIGHT', gameState.boss.x, gameState.boss.y - BOSS_RADIUS - 30);
    }
    
    // 4. 弾丸描画 (プレイヤー/ボス)
    gameState.projectiles.forEach(p => {
        drawCircle(ctx, p.x, p.y, p.radius, p.color, p.color);
    });

    // 5. プレイヤー描画
    Object.values(gameState.players).forEach(p => {
        if (!p.isDead) {
            const jobData = JOB_DATA[p.job] || {};
            const playerColor = p.color;
            
            // プレイヤー
            drawPlayer(ctx, p, playerColor);

            // 自身を強調
            if (p.id === game.playerId) {
                drawCircle(ctx, p.x, p.y, PLAYER_RADIUS + 5, 'rgba(255, 255, 0, 0.3)', 'rgba(255, 255, 0, 0.0)');
            }
            
            // オートアタック射程
            drawAutoAttackRange(ctx, p, false);

            // 体力バー
            drawHealthBar(ctx, p.x, p.y - PLAYER_RADIUS - 10, 50, 8, p.hp, p.maxHp, 'lime');

            // プレイヤーIDと職業
            ctx.fillStyle = 'white';
            ctx.font = '12px Arial';
            ctx.textAlign = 'center';
            ctx.fillText(`${p.id} [${jobData.name}]`, p.x, p.y + PLAYER_RADIUS + 15);

            // スキルCT表示 (自機周り)
            if (p.id === game.playerId) {
                drawSkillCooldowns(ctx, p);
            }
        }
    });
}

function drawPlayer(ctx, p, color) {
    drawCircle(ctx, p.x, p.y, PLAYER_RADIUS, color, color);
    
    // 自身を示すためのマーク
    if (p.id === game.playerId) {
        ctx.fillStyle = 'white';
        ctx.beginPath();
        ctx.arc(p.x, p.y, PLAYER_RADIUS / 2, 0, Math.PI * 2);
        ctx.fill();
    }
}

function drawAutoAttackRange(ctx, p, isLobby) {
    if (!p.job) return;
    const range = JOB_DATA[p.job].range || AUTO_ATTACK_RANGE; // ロビーではJOB_DATAから、ゲームではサーバーから
    
    ctx.strokeStyle = p.color + '40';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 5]);

    ctx.beginPath();
    ctx.arc(p.x, p.y, range, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
}

function drawSkillCooldowns(ctx, p) {
    const skills = [p.skill1, p.skill2, p.super];
    const jobData = JOB_DATA[p.job];
    const centerX = p.x;
    const centerY = p.y;
    const radius = PLAYER_RADIUS + 30;
    const now = Date.now();
    
    skills.forEach((skill, index) => {
        const angle = Math.PI * 2 / 3 * index - Math.PI / 2;
        const x = centerX + Math.cos(angle) * radius;
        const y = centerY + Math.sin(angle) * radius;
        
        // CTサークル
        const totalCD = jobData[`skill${index + 1}`]?.cd || jobData.super.cd;
        const timeRemaining = Math.max(0, (skill.nextCastTime || 0) - now);
        const percentCD = 1 - (timeRemaining / totalCD);
        
        drawCircle(ctx, x, y, 15, 'rgba(255, 255, 255, 0.8)', '#333');
        
        // CTゲージ (円弧)
        ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.arc(x, y, 15, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * percentCD);
        ctx.closePath();
        ctx.fill();

        // スキル番号
        ctx.fillStyle = 'white';
        ctx.font = '14px Arial';
        ctx.textAlign = 'center';
        ctx.fillText(index + 1, x, y + 5);
    });
}


// --- 汎用描画関数 ---
function drawCircle(ctx, x, y, r, fill, stroke) {
    ctx.fillStyle = fill;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    if (stroke) ctx.stroke();
}

function drawHealthBar(ctx, x, y, width, height, current, max, color) {
    const percent = current / max;
    ctx.fillStyle = 'black';
    ctx.fillRect(x - width / 2, y, width, height);
    
    ctx.fillStyle = color;
    ctx.fillRect(x - width / 2, y, width * percent, height);
    
    ctx.strokeStyle = 'white';
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
        row.insertCell().textContent = playerStat.healingDone.toLocaleString();
        
        row.style.color = gameState.players[playerStat.id]?.color || '#333';
        row.style.fontWeight = 'bold';
    });

    showScreen('result');
}