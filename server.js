// server.js (Server-side - Node.js)
// 実行前に npm install ws uuid を実行してください
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

const WSS_PORT = 8080;
const wss = new WebSocket.Server({ port: WSS_PORT });

// --- 定数定義 (クライアントと同期) ---
const CANVAS_SIZE = 800;
const LOBBY_CANVAS_SIZE = 600; 
const LOBBY_CENTER = LOBBY_CANVAS_SIZE / 2;
const BOSS_RADIUS = 50;
const PLAYER_RADIUS = 20;
const SPAWN_DISTANCE = 300; // プレイヤーの初期配置距離 (ゲーム中リスポーン用)
const PLAYER_MAX_HP = 1000;
const BASE_DEATH_TIME = 5000; // 基礎死亡時間 (5秒)
const AUTO_ATTACK_CD = 500;
const GAME_START_COUNTDOWN = 3; // 秒

const JOB_DATA = {
    MELEE: { 
        name: '近接アタッカー', 
        color: '#F44336', 
        speed: 24, 
        range: 100, 
        autoAttackDamage: 50,
        skill1: { name: '突進', cd: 8000, range: 100 },
        skill2: { name: '防御', cd: 15000, duration: 3000 },
        super: { name: '大回転斬り', cd: 40000, range: 150 }
    },
    RANGED: {
        name: '遠距離アタッカー',
        color: '#2196F3',
        speed: 30, 
        range: 500, 
        autoAttackDamage: 30,
        skill1: { name: '後退射撃', cd: 5000, backstep: 100 },
        skill2: { name: '広範囲爆撃', cd: 10000, range: 300 },
        super: { name: 'バースト射撃', cd: 45000, duration: 5000 }
    },
    HEALER: {
        name: 'ヒーラー',
        color: '#4CAF50',
        speed: 30, 
        range: 300, 
        autoAttackDamage: 10,
        skill1: { name: '緊急回復', cd: 8000, heal: 200 },
        skill2: { name: 'バフ', cd: 15000, duration: 5000 },
        super: { name: '範囲回復', cd: 40000, heal: 500 }
    },
    SUPPORTER: { 
        name: 'サポーター',
        color: '#FFEB3B',
        speed: 32, 
        range: 350, 
        autoAttackDamage: 15,
        skill1: { name: 'デバフ付与', cd: 10000, effect: 'debuff' },
        skill2: { name: 'シールド付与', cd: 12000, effect: 'shield' },
        super: { name: '戦場支配', cd: 50000, duration: 8000 }
    }
};

// --- ゲーム状態管理 ---
let gameState = {
    isGameRunning: false,
    players: {}, 
    boss: null,
    gameInterval: null,
    gameStartTime: 0,
    bossSettings: {
        maxHpMultiplier: 10, // 10x1000 = 10000 HP
        damageMultiplier: 1.0
    },
    stats: {},
    activeAttacks: [] 
};

// --- ユーティリティ関数 (省略) ---
function calculateNewPosition(x, y, dx, dy, speed, areaSize) {
    let newX = x + dx * speed;
    let newY = y + dy * speed;
    const min = PLAYER_RADIUS;
    const max = areaSize - PLAYER_RADIUS;
    newX = Math.max(min, Math.min(max, newX));
    newY = Math.max(min, Math.min(max, newY));
    return { x: newX, y: newY };
}

// --- プレイヤー クラス (省略) ---
class Player {
    constructor(id, job) {
        this.id = id;
        this.name = `Player ${id.substring(0, 4)}`;
        this.job = job;
        this.maxHp = PLAYER_MAX_HP;
        this.currentHp = PLAYER_MAX_HP;
        this.isAlive = true;
        this.deathTimer = 0; 
        this.x = LOBBY_CENTER;
        this.y = LOBBY_CENTER; 
        this.speed = job ? JOB_DATA[job].speed : 1;
        this.range = job ? JOB_DATA[job].range : 1;
        this.autoAttack = { nextCastTime: 0 };
        this.skill1 = { nextCastTime: 0 };
        this.skill2 = { nextCastTime: 0 };
        this.super = { nextCastTime: 0 };
        
        gameState.stats[id] = {
            id: id,
            job: job,
            deaths: 0, 
            damageDealt: 0,
            healingDone: 0
        };
    }
    
    move(dx, dy) {
        let areaSize = gameState.isGameRunning ? CANVAS_SIZE : LOBBY_CANVAS_SIZE;
        const newPos = calculateNewPosition(this.x, this.y, dx, dy, this.speed, areaSize); 
        this.x = newPos.x;
        this.y = newPos.y;
    }
    
    die() {
        this.isAlive = false;
        // 死亡回数 × 5秒間死亡判定
        const deathCount = gameState.stats[this.id].deaths;
        this.deathTimer = (deathCount + 1) * BASE_DEATH_TIME; // 1回目: 5s, 2回目: 10s...
        gameState.stats[this.id].deaths++;
    }

    spawn() {
        this.isAlive = true;
        this.currentHp = this.maxHp;
        this.deathTimer = 0;
        
        // プレイヤーを円形に配置
        const playerIds = Object.keys(gameState.players).filter(id => gameState.players[id].job);
        const index = playerIds.indexOf(this.id);
        const count = playerIds.length;
        
        if (count > 0 && index !== -1) {
            const angle = (index / count) * 2 * Math.PI;
            this.x = CANVAS_SIZE / 2 + Math.cos(angle) * SPAWN_DISTANCE;
            this.y = CANVAS_SIZE / 2 + Math.sin(angle) * SPAWN_DISTANCE;
        } else {
            this.x = CANVAS_SIZE / 2;
            this.y = CANVAS_SIZE / 2 + 100;
        }
    }
}


// --- ボス クラス (省略) ---
class Boss {
    constructor(hpMult) {
        this.baseHp = 10000;
        this.maxHp = Math.round(this.baseHp * hpMult / 10); // HP乗数10で10000になるように調整
        this.currentHp = this.maxHp;
        this.x = CANVAS_SIZE / 2;
        this.y = CANVAS_SIZE / 2;
        this.radius = BOSS_RADIUS;
        this.lastAttackTime = Date.now();
        this.attackCooldown = 3000;
        this.currentPattern = 1;
    }
    
    update(now, damageMult) {
        const hpPercent = this.currentHp / this.maxHp;
        
        // HPの減り具合に応じてパターンを変更
        if (hpPercent <= 0.3 && this.currentPattern < 3) {
            this.currentPattern = 3; // 最終フェーズ
            this.attackCooldown = 1500;
        } else if (hpPercent <= 0.6 && this.currentPattern < 2) {
            this.currentPattern = 2; // 第二フェーズ
            this.attackCooldown = 2000;
        }
        
        // ボス攻撃の発動ロジック (簡易的な範囲攻撃)
        if (now - this.lastAttackTime >= this.attackCooldown) {
            this.lastAttackTime = now;
            
            let attackDuration = this.currentPattern === 3 ? 1500 : 2000;
            let attack = {
                id: uuidv4(),
                type: 'CIRCLE',
                x: this.x,
                y: this.y,
                radius: this.currentPattern === 1 ? 300 : 400,
                damage: 100 * damageMult * this.currentPattern, 
                damageTime: now + attackDuration,
                duration: attackDuration
            };
            
            gameState.activeAttacks.push(attack);
        }
        
        // 攻撃の解決とダメージ処理
        gameState.activeAttacks = gameState.activeAttacks.filter(attack => {
            if (now >= attack.damageTime) {
                Object.values(gameState.players).forEach(player => {
                    if (!player.isAlive) return;
                    
                    const dist = Math.sqrt(
                        Math.pow(player.x - attack.x, 2) + Math.pow(player.y - attack.y, 2)
                    );
                    
                    if (dist < attack.radius + PLAYER_RADIUS) {
                        player.currentHp -= attack.damage;
                        if (player.currentHp <= 0) {
                            player.die();
                        }
                    }
                });
                return false;
            }
            return true;
        });
    }
}


// --- メインロジック ---

function resetGameState() {
    clearInterval(gameState.gameInterval);
    gameState.isGameRunning = false;
    gameState.boss = null;
    gameState.gameStartTime = 0;
    gameState.activeAttacks = [];
    
    // プレイヤーの位置をロビーに戻す
    Object.values(gameState.players).forEach(player => {
        player.x = LOBBY_CENTER;
        player.y = LOBBY_CENTER;
        player.currentHp = PLAYER_MAX_HP;
        player.isAlive = true;
        player.deathTimer = 0;
        // 統計情報をリセット（ゲーム終了時にのみ行うため、ここではjob情報の更新は不要）
    });
    
    // 統計情報をリセット
    gameState.stats = {};
    Object.keys(gameState.players).forEach(id => {
        if (gameState.players[id]) {
            gameState.stats[id] = {
                id: id,
                job: gameState.players[id].job,
                deaths: 0,
                damageDealt: 0,
                healingDone: 0
            };
        }
    });
}

/**
 * ゲーム開始処理 (ホストのみ実行可能)
 * @returns {void}
 */
function startGame() {
    if (gameState.isGameRunning) return;

    // ★ ロジック確認: 全員が職業を選択しているかチェック
    const allReady = Object.values(gameState.players).every(p => p.job && p.job !== null);
    if (!allReady) {
        console.log("ゲーム開始失敗: 職業未選択のプレイヤーがいます。");
        return; 
    }

    gameState.isGameRunning = true;
    gameState.gameStartTime = Date.now() + GAME_START_COUNTDOWN * 1000;
    
    // ホスト設定のHP乗数を使用してボスを初期化
    gameState.boss = new Boss(gameState.bossSettings.maxHpMultiplier);

    Object.values(gameState.players).forEach(player => player.spawn());

    // 60FPSでゲームループを開始
    gameState.gameInterval = setInterval(gameLoop, 1000 / 60);

    // ★ ゲーム開始をクライアントに通知するため、即座にGAME_STATEをブロードキャスト
    broadcastGameState(); 
    console.log("ゲームが開始されました。");
}

function gameLoop() {
    const now = Date.now();
    
    if (now < gameState.gameStartTime) {
        broadcastGameState();
        return;
    }

    // 死亡処理と蘇生タイマー
    Object.values(gameState.players).forEach(player => {
        if (!player.isAlive) {
            player.deathTimer -= 1000 / 60;
            if (player.deathTimer <= 0) {
                player.spawn();
            }
            return;
        }
        
        // 1. プレイヤーによるボスへの通常攻撃判定 (オートエイム)
        if (player.job && player.autoAttack.nextCastTime <= now && gameState.boss) {
            const jobData = JOB_DATA[player.job];
            const dist = Math.sqrt(
                Math.pow(player.x - gameState.boss.x, 2) + Math.pow(player.y - gameState.boss.y, 2)
            );
            
            if (dist < jobData.range + BOSS_RADIUS) {
                gameState.boss.currentHp -= jobData.autoAttackDamage;
                gameState.stats[player.id].damageDealt += jobData.autoAttackDamage;
                player.autoAttack.nextCastTime = now + AUTO_ATTACK_CD;
            }
        }
    });
    
    // 2. ボスのアクション
    if (gameState.boss) {
        gameState.boss.update(now, gameState.bossSettings.damageMultiplier);
    }

    // 3. 勝敗判定
    if (gameState.boss && gameState.boss.currentHp <= 0) {
        endGame('WIN');
    } else {
        const allDead = Object.values(gameState.players).filter(p => p.job).every(p => !p.isAlive);
        if (allDead) {
            endGame('LOSE');
        }
    }
    
    broadcastGameState();
}

function endGame(result) {
    clearInterval(gameState.gameInterval);
    gameState.isGameRunning = false;
    const resultData = {
        type: 'GAME_END',
        result: result,
        stats: gameState.stats,
        jobData: JOB_DATA 
    };
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(resultData));
        }
    });
    resetGameState();
}

// --- ブロードキャスト関数 ---

function broadcastLobbyState() {
    const playerIds = Object.keys(gameState.players);
    const hostId = playerIds[0] || null; // 最初のプレイヤーをホストIDとする
    
    const lobbyState = {
        type: 'LOBBY_STATE',
        players: Object.values(gameState.players).map(p => ({
            id: p.id,
            name: p.name,
            job: p.job,
            color: p.job ? JOB_DATA[p.job].color : '#555',
            x: p.x,
            y: p.y
        })),
        isGameRunning: gameState.isGameRunning,
        bossSettings: gameState.bossSettings
    };
    
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(lobbyState));
        }
    });
}

function broadcastGameState() {
    const gameStatePacket = {
        type: 'GAME_STATE',
        isGameRunning: gameState.isGameRunning,
        gameStartTime: gameState.gameStartTime,
        jobData: JOB_DATA,
        boss: gameState.boss ? { 
            x: gameState.boss.x, 
            y: gameState.boss.y, 
            radius: gameState.boss.radius, 
            currentHp: gameState.boss.currentHp, 
            maxHp: gameState.boss.maxHp
        } : null,
        activeAttacks: gameState.activeAttacks.map(a => ({
            id: a.id,
            type: a.type,
            x: a.x,
            y: a.y,
            radius: a.radius,
            damageTime: a.damageTime,
            duration: a.duration
        })),
        players: Object.values(gameState.players).map(p => ({
            id: p.id,
            name: p.name,
            job: p.job,
            color: p.job ? JOB_DATA[p.job].color : '#555',
            x: p.x,
            y: p.y,
            currentHp: p.currentHp,
            maxHp: p.maxHp,
            isAlive: p.isAlive,
            deathTimer: p.deathTimer,
            range: p.range,
            skill1: { nextCastTime: p.skill1.nextCastTime },
            skill2: { nextCastTime: p.skill2.nextCastTime },
            super: { nextCastTime: p.super.nextCastTime },
            stats: gameState.stats[p.id]
        })),
        bossSettings: gameState.bossSettings
    };

    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(gameStatePacket));
        }
    });
}

// --- WebSocket接続処理 ---
wss.on('connection', function connection(ws, req) {
    const playerId = uuidv4();
    ws.playerId = playerId;
    
    // プレイヤーの生成 (初期のjobはnull)
    const player = new Player(playerId, null);
    gameState.players[playerId] = player;
    
    const playerIds = Object.keys(gameState.players);
    const isHost = playerIds[0] === playerId;

    // 初期状態を送信
    ws.send(JSON.stringify({ 
        type: 'INITIAL_STATE', 
        playerId: playerId,
        jobData: JOB_DATA,
        isHost: isHost, // クライアントがホストかどうかを通知
        bossSettings: gameState.bossSettings
    }));
    
    broadcastLobbyState();

    ws.on('message', function incoming(message) {
        const data = JSON.parse(message);
        const player = gameState.players[ws.playerId];
        const now = Date.now();

        switch (data.type) {
            case 'MOVE_LOBBY':
            case 'MOVE':
                if (player && (data.dx !== 0 || data.dy !== 0)) {
                    if (gameState.isGameRunning && !player.isAlive) return; 
                    player.move(data.dx, data.dy);
                    if (data.type === 'MOVE_LOBBY') {
                        broadcastLobbyState();
                    }
                }
                break;
                
            case 'SELECT_JOB':
                if (player && JOB_DATA[data.jobKey] && !gameState.isGameRunning) {
                    player.job = data.jobKey;
                    player.speed = JOB_DATA[data.jobKey].speed;
                    player.range = JOB_DATA[data.jobKey].range;
                    if (gameState.stats[player.id]) gameState.stats[player.id].job = data.jobKey;
                    broadcastLobbyState();
                }
                break;

            case 'START_GAME':
                // ★ ロジック確認: 最初の接続者（ホスト）のみが実行可能
                if (Object.keys(gameState.players)[0] === ws.playerId) {
                    startGame();
                }
                break;
                
            case 'USE_SKILL':
                const skillKey = data.skillKey;
                const jobData = JOB_DATA[player.job];
                const skillData = jobData ? jobData[skillKey] : null;
                
                if (!player.isAlive) return; 
                
                if (skillData && player[skillKey].nextCastTime <= now) {
                    player[skillKey].nextCastTime = now + skillData.cd;
                    
                    // 簡易的な回復スキル処理 (ヒーラーのスキル1)
                    if (player.job === 'HEALER' && skillKey === 'skill1') {
                         Object.values(gameState.players).forEach(target => {
                            if (target.isAlive && target.currentHp < target.maxHp) {
                                const dist = Math.sqrt(Math.pow(player.x - target.x, 2) + Math.pow(player.y - target.y, 2));
                                if (dist < jobData.range + PLAYER_RADIUS) {
                                    const healAmount = skillData.heal;
                                    target.currentHp = Math.min(target.maxHp, target.currentHp + healAmount);
                                    gameState.stats[player.id].healingDone += healAmount;
                                }
                            }
                        });
                    }
                    // その他のスキルロジックは省略
                }
                break;
            
            case 'SET_BOSS_HP':
                if (Object.keys(gameState.players)[0] === ws.playerId && !gameState.isGameRunning) {
                    gameState.bossSettings.maxHpMultiplier = data.multiplier;
                    broadcastLobbyState();
                }
                break;
            case 'SET_BOSS_DAMAGE':
                 if (Object.keys(gameState.players)[0] === ws.playerId && !gameState.isGameRunning) {
                    gameState.bossSettings.damageMultiplier = data.multiplier;
                    broadcastLobbyState();
                }
                break;
        }
    });

    ws.on('close', () => {
        if (ws.playerId) {
            console.log(`Player ${ws.playerId} disconnected.`);
            delete gameState.players[ws.playerId];
            
            if (Object.keys(gameState.players).length === 0) {
                clearInterval(gameState.gameInterval);
                resetGameState();
                console.log('Game state fully reset.');
            } else {
                if (!gameState.isGameRunning) {
                    broadcastLobbyState();
                }
            }
        }
    });
});

console.log(`WebSocket Server running on ws://localhost:${WSS_PORT}`);
console.log('クライアントは index.html をブラウザで開いてアクセスしてください。');