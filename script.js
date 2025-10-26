// script.js (Client-side)

// 定数定義
const CANVAS_SIZE = 800;
const LOBBY_CANVAS_SIZE = 600;
const PLAYER_RADIUS = 20;
const BOSS_RADIUS = 50;
const LOBBY_DUMMY_BOSS_RADIUS = 40; 
const MOVE_DELAY = 33; 
const JOB_INTERACT_DISTANCE = 80;

// 職業ごとの設定 (サーバーと同期)
const JOB_DATA = {
    MELEE: {
        name: '近接アタッカー',
        color: '#F44336',
        description: '高耐久・高火力。ボスに密着して戦う。',
        range: 100, 
        skill1: { name: '突進', cd: 8000 },
        skill2: { name: '防御', cd: 15000 },
        super: { name: '大回転斬り', cd: 40000 }
    },
    RANGED: {
        name: '遠距離アタッカー',
        color: '#2196F3',
        description: '遠距離からの攻撃が得意。機動力に優れる。',
        range: 500,
        skill1: { name: '後退射撃', cd: 5000 },
        skill2: { name: '広範囲爆撃', cd: 10000 },
        super: { name: 'バースト射撃', cd: 45000 }
    },
    HEALER: {
        name: 'ヒーラー',
        color: '#4CAF50',
        description: '味方を回復し、サポートする。',
        range: 300,
        skill1: { name: '緊急回復', cd: 8000 },
        skill2: { name: 'バフ', cd: 15000 },
        super: { name: '範囲回復', cd: 40000 }
    },
    SUPPORTER: { 
        name: 'サポーター',
        color: '#FFEB3B',
        description: 'デバフやシールドで戦況を有利にする。',
        range: 350,
        skill1: { name: 'デバフ付与', cd: 10000 },
        skill2: { name: 'シールド付与', cd: 12000 },
        super: { name: '戦場支配', cd: 50000 }
    }
};

const JOB_INTERACT_POSITIONS = {
    MELEE: { x: LOBBY_CANVAS_SIZE / 2, y: LOBBY_CANVAS_SIZE / 2 - 200 }, 
    RANGED: { x: LOBBY_CANVAS_SIZE / 2 + 200, y: LOBBY_CANVAS_SIZE / 2 },
    HEALER: { x: LOBBY_CANVAS_SIZE / 2, y: LOBBY_CANVAS_SIZE / 2 + 200 },
    SUPPORTER: { x: LOBBY_CANVAS_SIZE / 2 - 200, y: LOBBY_CANVAS_SIZE / 2 }
};

// --- グローバル変数 ---
let ws;
let game = {
    playerId: null,
    players: {},
    boss: null,
    isGameRunning: false,
    jobData: JOB_DATA, 
    currentScreen: 'title', 
    lastMoveTime: 0, 
    gameStartTime: 0,
    stats: {},
    isHost: false, // ホスト判定
    bossSettings: {}, // ホスト設定
    activeAttacks: [] // ボスの攻撃予兆
};

// --- DOM要素とキャンバス ---
let screens = {};
let lobbyCanvas, lobbyCtx;
let gameCanvas, gameCtx;
let selectJobButtons = {}; 

// --- 画面遷移関数 ---
function changeScreen(nextScreen) {
    Object.keys(screens).forEach(key => {
        if (screens[key]) {
            screens[key].classList.remove('active');
        }
    });
    if (screens[nextScreen]) {
        screens[nextScreen].classList.add('active');
        if (nextScreen === 'lobby') {
            requestAnimationFrame(drawLobby);
            if (game.isHost) {
                setupHostSettingsListeners(); // ホストになったらスライダーリスナーを再設定
            }
        }
        if (nextScreen === 'game') {
            requestAnimationFrame(drawGame);
        }
    }
    game.currentScreen = nextScreen;
}

// --- WebSocket通信 ---
function connectToServer(address) {
    if (ws) ws.close();
    const protocol = address.startsWith('localhost') || address.startsWith('127.0.0.1') ? 'ws' : 'wss';
    const fullAddress = `${protocol}://${address}`;
    const connectionStatus = document.getElementById('connection-status');
    if (connectionStatus) connectionStatus.textContent = '接続中...';
    try {
        ws = new WebSocket(fullAddress);
    } catch (error) {
        if (connectionStatus) connectionStatus.textContent = '未接続';
        return;
    }
    ws.onopen = () => {
        changeScreen('lobby');
        if (connectionStatus) connectionStatus.textContent = '接続済み';
        if (screens['connection-modal']) screens['connection-modal'].classList.remove('active');
    };
    ws.onmessage = (event) => {
        handleServerMessage(JSON.parse(event.data));
    };
    ws.onclose = () => {
        alert('サーバーから切断されました。');
        changeScreen('title');
        game.players = {};
        game.playerId = null;
        if (connectionStatus) connectionStatus.textContent = '未接続';
    };
    ws.onerror = (error) => {
        alert('接続エラーが発生しました。');
        changeScreen('title');
        if (screens['connection-modal']) screens['connection-modal'].classList.remove('active');
        if (connectionStatus) connectionStatus.textContent = '未接続';
    };
}

function sendAction(type, payload = {}) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type, ...payload }));
    }
}

function handleServerMessage(data) {
    switch (data.type) {
        case 'INITIAL_STATE':
            game.playerId = data.playerId;
            game.jobData = data.jobData;
            game.isHost = data.isHost; // サーバーからのホストフラグを使用
            game.bossSettings = data.bossSettings || {};
            updateJobSelectionUI();
            break;
            
        case 'LOBBY_STATE':
            game.players = data.players.reduce((acc, p) => { acc[p.id] = p; return acc; }, {});
            game.isGameRunning = data.isGameRunning;
            // ホスト判定: プレイヤーリストの最初のIDが自分のIDと一致するか
            const hostId = data.players.length > 0 ? data.players[0].id : null;
            game.isHost = game.playerId === hostId;
            
            game.bossSettings = data.bossSettings || {};
            updateLobbyUI(); // UI更新関数を呼び出す
            // ★ 修正前: LOBBY_STATEで画面遷移しようとしていたが、サーバーはGAME_STATEに切り替わるため削除
            // if (game.isGameRunning) { changeScreen('game'); } 
            break;

        case 'GAME_STATE':
            game.players = data.players.reduce((acc, p) => { acc[p.id] = p; return acc; }, {});
            game.boss = data.boss;
            game.isGameRunning = data.isGameRunning;
            game.gameStartTime = data.gameStartTime;
            game.jobData = data.jobData;
            game.activeAttacks = data.activeAttacks || [];
            
            // ★ 修正: GAME_STATEを受け取り、isGameRunningなら画面遷移する
            if (game.isGameRunning) {
                changeScreen('game');
            }
            break;

        case 'GAME_END':
            completeLevel(data.result, data.stats, data.jobData);
            changeScreen('result');
            break;
    }
}

// --- 描画ヘルパー関数 (省略) ---
function drawHealthBar(ctx, x, y, width, height, percent, color) { /* ... */ }
function drawAttackRange(ctx, x, y, range, color) { /* ... */ }
function drawAutoAttackBeam(ctx, x1, y1, x2, y2, color) { /* ... */ }
function drawSkillCooldowns(ctx, player, jobData) { /* ... */ }


// --- ロビー画面の描画 ---
function drawLobby() { 
    if (!lobbyCtx || game.currentScreen !== 'lobby') return;
    
    // 背景を白で塗りつぶす
    lobbyCtx.fillStyle = '#FFFFFF'; 
    lobbyCtx.fillRect(0, 0, LOBBY_CANVAS_SIZE, LOBBY_CANVAS_SIZE);

    // ロビーの境界線
    lobbyCtx.strokeStyle = '#333';
    lobbyCtx.lineWidth = 5;
    lobbyCtx.strokeRect(0, 0, LOBBY_CANVAS_SIZE, LOBBY_CANVAS_SIZE);

    // 1. ダミーの敵 (ボス) を中央に配置
    const dummyBoss = { x: LOBBY_CANVAS_SIZE / 2, y: LOBBY_CANVAS_SIZE / 2 };
    lobbyCtx.beginPath();
    lobbyCtx.arc(dummyBoss.x, dummyBoss.y, LOBBY_DUMMY_BOSS_RADIUS, 0, Math.PI * 2);
    lobbyCtx.fillStyle = '#C0C0C0';
    lobbyCtx.fill();
    lobbyCtx.strokeStyle = '#333';
    lobbyCtx.lineWidth = 3;
    lobbyCtx.stroke();
    lobbyCtx.fillStyle = '#000';
    lobbyCtx.font = 'bold 16px Arial';
    lobbyCtx.textAlign = 'center';
    lobbyCtx.fillText('ダミーボス', dummyBoss.x, dummyBoss.y + 5);


    const myPlayer = game.players[game.playerId];
    if (myPlayer) {
        const myJobKey = myPlayer.job;

        // 2. 職業選択のインタラクト (四方) を配置
        Object.keys(JOB_INTERACT_POSITIONS).forEach(jobKey => {
            const pos = JOB_INTERACT_POSITIONS[jobKey];
            const isSelected = myJobKey === jobKey;
            const jobData = game.jobData[jobKey];

            const dist = Math.sqrt(
                Math.pow(myPlayer.x - pos.x, 2) + Math.pow(myPlayer.y - pos.y, 2)
            );
            
            // インタラクト可能範囲の表示
            lobbyCtx.beginPath();
            lobbyCtx.arc(pos.x, pos.y, JOB_INTERACT_DISTANCE, 0, Math.PI * 2);
            lobbyCtx.strokeStyle = isSelected ? jobData.color + '80' : 'rgba(0, 0, 0, 0.1)';
            lobbyCtx.lineWidth = 1;
            lobbyCtx.stroke();
            
            // インタラクト円の描画
            lobbyCtx.beginPath();
            lobbyCtx.arc(pos.x, pos.y, 10, 0, Math.PI * 2);
            lobbyCtx.fillStyle = isSelected ? jobData.color : '#6c757d';
            lobbyCtx.fill();
            
            // 職業名
            lobbyCtx.fillStyle = '#333';
            lobbyCtx.font = '14px Arial';
            lobbyCtx.textAlign = 'center';
            lobbyCtx.fillText(jobData.name, pos.x, pos.y - 15);

            // 近づいたプレイヤーに詳細を表示 (自身にのみ)
            if (dist < JOB_INTERACT_DISTANCE + PLAYER_RADIUS) {
                lobbyCtx.fillStyle = '#000';
                lobbyCtx.font = '12px Arial';
                lobbyCtx.textAlign = 'center';
                lobbyCtx.fillText(`[E]で転職: ${jobData.description}`, pos.x, pos.y + 25);
            }
        });

        // 3. 選択中のプレイヤーの通常攻撃射程を表示
        if (myJobKey) {
            const range = game.jobData[myJobKey].range;
            drawAttackRange(lobbyCtx, myPlayer.x, myPlayer.y, range, myPlayer.color);
            
            // 4. ダミーボスへの自動攻撃アニメーション
            const distToBoss = Math.sqrt(
                Math.pow(myPlayer.x - dummyBoss.x, 2) + Math.pow(myPlayer.y - dummyBoss.y, 2)
            );
            if (distToBoss < range + LOBBY_DUMMY_BOSS_RADIUS) {
                 drawAutoAttackBeam(lobbyCtx, myPlayer.x, myPlayer.y, dummyBoss.x, dummyBoss.y, myPlayer.color);
            }
        }
    }
    
    // 5. プレイヤーを描画 (ロビー)
    Object.values(game.players).forEach(player => {
        const isSelf = player.id === game.playerId;
        
        lobbyCtx.beginPath();
        lobbyCtx.arc(player.x, player.y, PLAYER_RADIUS, 0, Math.PI * 2);
        lobbyCtx.fillStyle = player.color || '#555';
        lobbyCtx.fill();
        lobbyCtx.strokeStyle = isSelf ? '#FFD700' : '#111'; // 自機を強調 (金の縁)
        lobbyCtx.lineWidth = isSelf ? 4 : 2;
        lobbyCtx.stroke();
        
        lobbyCtx.fillStyle = '#333';
        lobbyCtx.font = '12px Arial';
        lobbyCtx.textAlign = 'center';
        lobbyCtx.fillText(player.name, player.x, player.y - PLAYER_RADIUS - 5);
    });
    
    requestAnimationFrame(drawLobby);
}


// --- ゲーム画面の描画 (省略) ---
function drawGame() { /* ... */ }

// --- UI更新関数 ---
function updateJobSelectionUI() {
    // 職業ボタンのUIを更新するロジック (省略)
}

function updateLobbyUI() {
    const startButton = document.getElementById('start-game-button');
    const hostSettingsPanel = document.getElementById('host-settings-panel');
    const playerListDiv = document.getElementById('lobby-player-list');
    
    // 1. 参加プレイヤーリストの更新
    if (playerListDiv) {
        const playerArray = Object.values(game.players);
        const hostId = playerArray.length > 0 ? playerArray[0].id : null;
        let playerListHTML = '<h4>参加プレイヤー: ' + playerArray.length + '人</h4>';
        playerListHTML += '<ul>';
        playerArray.forEach(p => {
            const status = p.job ? `✅ ${game.jobData[p.job].name}` : '❌ 職業未選択';
            const isHostLabel = p.id === hostId ? ' (ホスト)' : ''; 
            playerListHTML += `<li><span style="color: ${p.color}; font-weight: bold;">■</span> ${p.name}${isHostLabel}: ${status}</li>`;
        });
        playerListHTML += '</ul>';
        playerListDiv.innerHTML = playerListHTML;
    }
    
    // 2. ホスト専用UIの表示/非表示とボタン有効化
    if (game.isHost && startButton) {
        startButton.style.display = 'block';
        if (hostSettingsPanel) hostSettingsPanel.style.display = 'block';

        // ゲーム開始ボタンの有効化判定: 全員が職業を選択しているか
        const activePlayers = Object.values(game.players).length;
        const allReady = activePlayers > 0 && Object.values(game.players).every(p => p.job && p.job !== null);
        
        startButton.disabled = !allReady;
        startButton.textContent = allReady ? 'ゲーム開始' : '職業未選択のプレイヤーがいます';
        
    } else if (startButton) {
        startButton.style.display = 'none';
        if (hostSettingsPanel) hostSettingsPanel.style.display = 'none';
    }
    
    setupHostSettingsListeners(); // ホスト設定のUI値を更新
}

function completeLevel(result, stats, jobData) { 
    // リザルト画面の表示ロジック (省略)
    const resultTitle = document.getElementById('result-title');
    const resultMessage = document.getElementById('result-message');
    const resultTableBody = document.querySelector('#result-table tbody');

    if (result === 'WIN') {
        resultTitle.textContent = '🏆 勝利！';
        resultMessage.textContent = 'YOU WIN!';
        resultMessage.style.color = 'green';
    } else {
        resultTitle.textContent = '💀 敗北...';
        resultMessage.textContent = 'GAME OVER.';
        resultMessage.style.color = 'red';
    }

    if (resultTableBody) {
        resultTableBody.innerHTML = '';
        Object.values(stats).forEach(stat => {
            const row = resultTableBody.insertRow();
            row.insertCell().textContent = game.players[stat.id] ? game.players[stat.id].name : stat.id.substring(0, 4);
            row.insertCell().textContent = jobData[stat.job] ? jobData[stat.job].name : 'N/A';
            row.insertCell().textContent = stat.deaths;
            row.insertCell().textContent = stat.damageDealt.toLocaleString();
            row.insertCell().textContent = stat.healingDone.toLocaleString();
        });
    }
}


// --- UI/入力処理 ---

const keys = {};

function handleMovementInput() {
    // ... (移動入力ロジック)
    if (!game.playerId || !game.players[game.playerId]) return;
    if (Date.now() - game.lastMoveTime < MOVE_DELAY) return; 

    let dx = 0;
    let dy = 0;
    if (keys['w'] || keys['W'] || keys['ArrowUp']) dy -= 1;
    if (keys['s'] || keys['S'] || keys['ArrowDown']) dy += 1;
    if (keys['a'] || keys['A'] || keys['ArrowLeft']) dx -= 1;
    if (keys['d'] || keys['D'] || keys['ArrowRight']) dx += 1;

    if (dx !== 0 || dy !== 0) {
        const magnitude = Math.sqrt(dx * dx + dy * dy);
        const normalizedDx = dx / magnitude;
        const normalizedDy = dy / magnitude;
        const actionType = game.currentScreen === 'lobby' ? 'MOVE_LOBBY' : 'MOVE';
        sendAction(actionType, { dx: normalizedDx, dy: normalizedDy });
        game.lastMoveTime = Date.now();
    }
}

function trySelectJobByInteraction() {
    const myPlayer = game.players[game.playerId];
    if (!myPlayer || myPlayer.job) return;
    
    Object.keys(JOB_INTERACT_POSITIONS).forEach(jobKey => {
        const pos = JOB_INTERACT_POSITIONS[jobKey];
        const dist = Math.sqrt(
            Math.pow(myPlayer.x - pos.x, 2) + Math.pow(myPlayer.y - pos.y, 2)
        );
        
        if (dist < JOB_INTERACT_DISTANCE + PLAYER_RADIUS) {
            sendAction('SELECT_JOB', { jobKey });
        }
    });
}

// ホスト設定スライダーのイベントリスナー
function setupHostSettingsListeners() {
    const bossHpSlider = document.getElementById('boss-hp');
    const bossHpValueSpan = document.getElementById('boss-hp-value');
    
    if (bossHpSlider && bossHpValueSpan) {
        bossHpSlider.removeEventListener('input', handleBossHpChange);
        bossHpSlider.addEventListener('input', handleBossHpChange);
        // 初期値/ホスト設定でUIを更新
        bossHpSlider.value = game.bossSettings.maxHpMultiplier || 10;
        const initialHpValue = (parseFloat(bossHpSlider.value) * 1000).toLocaleString();
        bossHpValueSpan.textContent = `${initialHpValue} (x${bossHpSlider.value})`;
    }
    
    const bossDamageSlider = document.getElementById('boss-damage');
    const bossDamageValueSpan = document.getElementById('boss-damage-value');
    
    if (bossDamageSlider && bossDamageValueSpan) {
        bossDamageSlider.removeEventListener('input', handleBossDamageChange);
        bossDamageSlider.addEventListener('input', handleBossDamageChange);
        // 初期値/ホスト設定でUIを更新
        bossDamageSlider.value = game.bossSettings.damageMultiplier || 1.0;
        bossDamageValueSpan.textContent = `${parseFloat(bossDamageSlider.value).toFixed(1)}倍`;
    }
}
const handleBossHpChange = (e) => {
    const value = parseFloat(e.target.value);
    const displayValue = (value * 1000).toLocaleString();
    document.getElementById('boss-hp-value').textContent = `${displayValue} (x${value.toFixed(0)})`;
    sendAction('SET_BOSS_HP', { multiplier: value });
};
const handleBossDamageChange = (e) => {
    const value = parseFloat(e.target.value);
    document.getElementById('boss-damage-value').textContent = `${value.toFixed(1)}倍`;
    sendAction('SET_BOSS_DAMAGE', { multiplier: value });
};


document.addEventListener('DOMContentLoaded', () => {
    // DOM要素の取得と初期化
    screens['connection-modal'] = document.getElementById('connection-modal');
    screens['title'] = document.getElementById('title-screen');
    screens['lobby'] = document.getElementById('lobby-screen');
    screens['game'] = document.getElementById('game-screen');
    screens['result'] = document.getElementById('result-screen');

    lobbyCanvas = document.getElementById('lobby-canvas');
    if (lobbyCanvas) lobbyCtx = lobbyCanvas.getContext('2d');
    gameCanvas = document.getElementById('game-canvas');
    if (gameCanvas) gameCtx = gameCanvas.getContext('2d');
    
    selectJobButtons['MELEE'] = document.getElementById('select-melee');
    selectJobButtons['RANGED'] = document.getElementById('select-ranged');
    selectJobButtons['HEALER'] = document.getElementById('select-healer');
    selectJobButtons['SUPPORTER'] = document.getElementById('select-supporter'); 

    // UIイベントリスナー
    document.getElementById('join-room-button').addEventListener('click', () => {
        screens['connection-modal'].classList.add('active');
        document.getElementById('server-address').focus();
    });
    document.getElementById('create-room-button').addEventListener('click', () => {
        screens['connection-modal'].classList.add('active');
        document.getElementById('server-address').value = 'localhost:8080';
        document.getElementById('server-address').focus();
    });
    document.getElementById('connection-cancel').addEventListener('click', () => {
        screens['connection-modal'].classList.remove('active');
    });
    document.getElementById('connect-submit').addEventListener('click', () => {
        const address = document.getElementById('server-address').value;
        connectToServer(address);
    });
    document.getElementById('start-game-button').addEventListener('click', () => {
        sendAction('START_GAME');
    });
    document.getElementById('lobby-disconnect-button').addEventListener('click', () => {
        if (ws) ws.close();
        changeScreen('title');
    });
    document.getElementById('back-to-title').addEventListener('click', () => {
        if (ws) ws.close();
        changeScreen('title');
    });
    document.getElementById('back-to-select-clear').addEventListener('click', () => {
        if (ws) ws.close(); 
        changeScreen('title'); 
    });

    // 職業ボタンリスナー
    Object.keys(selectJobButtons).forEach(jobKey => {
        const button = selectJobButtons[jobKey];
        if (button) {
            button.addEventListener('click', () => {
                sendAction('SELECT_JOB', { jobKey });
            });
        }
    });

    // キーボードイベントリスナー
    document.addEventListener('keydown', (e) => {
        keys[e.key.toLowerCase()] = true;
        
        // Eキーでロビーでの転職を試みる
        if (e.key === 'e' || e.key === 'E') {
            if (game.currentScreen === 'lobby') {
                 trySelectJobByInteraction();
            }
        }
        
        // スキルキー
        if (game.currentScreen === 'game' && game.isGameRunning) {
            let skillKey;
            if (e.key === '1') skillKey = 'skill1';
            else if (e.key === '2') skillKey = 'skill2';
            else if (e.key === '3') skillKey = 'super';

            if (skillKey) {
                sendAction('USE_SKILL', { skillKey });
            }
        }
    });
    document.addEventListener('keyup', (e) => {
        keys[e.key.toLowerCase()] = false;
    });

    // 移動ループを開始
    setInterval(handleMovementInput, MOVE_DELAY);
    
    // ロビー描画の開始
    requestAnimationFrame(drawLobby);
});