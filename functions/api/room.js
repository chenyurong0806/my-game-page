export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const action = url.searchParams.get('action');

    // 检查是否绑定了 KV 数据库
    if (!env.GAME_KV) {
        return new Response(JSON.stringify({ error: "Cloudflare KV 未绑定" }), { status: 500 });
    }

    // 1. 获取房间列表
    if (action === 'list' && request.method === 'GET') {
        const gameId = url.searchParams.get('gameId');
        const list = await env.GAME_KV.list({ prefix: `room:${gameId}:` });
        const rooms = [];
        for (const key of list.keys) {
            const val = await env.GAME_KV.get(key.name, { type: 'json' });
            if (val) rooms.push({ id: val.id, status: val.status });
        }
        return new Response(JSON.stringify(rooms), { headers: { 'Content-Type': 'application/json' } });
    }

    // 2. 创建新房间
    if (action === 'create' && request.method === 'POST') {
        const { gameId } = await request.json();
        const roomId = Math.floor(100000 + Math.random() * 900000).toString(); // 随机6位房间号
        const newRoom = {
            id: roomId,
            gameId,
            status: 'waiting', // waiting, playing, finished
            p1: 'joined',
            p2: null,
            p1Score: 0,
            p2Score: 0,
            winner: null
        };
        await env.GAME_KV.put(`room:${gameId}:${roomId}`, JSON.stringify(newRoom), { expirationTtl: 3600 }); // 1小时后自动过期销毁
        return new Response(JSON.stringify({ roomId }), { headers: { 'Content-Type': 'application/json' } });
    }

    // 3. 加入房间 (P2 进入)
    if (action === 'join' && request.method === 'POST') {
        const { roomId } = await request.json();
        const kvKey = await findKeyByRoomId(env.GAME_KV, roomId);
        if (!kvKey) return new Response("房间不存在", { status: 404 });

        const room = await env.GAME_KV.get(kvKey, { type: 'json' });
        if (room.status === 'waiting') {
            room.p2 = 'joined';
            room.status = 'playing'; // 满两人自动开始
            await env.GAME_KV.put(kvKey, JSON.stringify(room), { expirationTtl: 3600 });
        }
        return new Response(JSON.stringify(room), { headers: { 'Content-Type': 'application/json' } });
    }

    // 4. 获取单个房间状态
    if (action === 'status' && request.method === 'GET') {
        const roomId = url.searchParams.get('roomId');
        const kvKey = await findKeyByRoomId(env.GAME_KV, roomId);
        if (!kvKey) return new Response("房间不存在", { status: 404 });

        const room = await env.GAME_KV.get(kvKey, { type: 'json' });
        return new Response(JSON.stringify(room), { headers: { 'Content-Type': 'application/json' } });
    }

    // 5. 核心对战逻辑：点击动作
    if (action === 'click' && request.method === 'POST') {
        const { roomId, player } = await request.json();
        const kvKey = await findKeyByRoomId(env.GAME_KV, roomId);
        if (!kvKey) return new Response("房间不存在", { status: 404 });

        const room = await env.GAME_KV.get(kvKey, { type: 'json' });
        if (room.status !== 'playing') return new Response("游戏未开始或已结束", { status: 400 });

        if (player === 'p1') room.p1Score += 1;
        if (player === 'p2') room.p2Score += 1;

        // 胜利条件：谁先点满 30 下
        if (room.p1Score >= 30) {
            room.status = 'finished';
            room.winner = 'p1';
        } else if (room.p2Score >= 30) {
            room.status = 'finished';
            room.winner = 'p2';
        }

        await env.GAME_KV.put(kvKey, JSON.stringify(room), { expirationTtl: 3600 });
        return new Response(JSON.stringify(room), { headers: { 'Content-Type': 'application/json' } });
    }

    return new Response("未知的操作", { status: 400 });
}

// 辅助函数：根据房间号在 KV 中搜索对应的 key
async function findKeyByRoomId(kvNamespace, roomId) {
    const list = await kvNamespace.list();
    for (const key of list.keys) {
        if (key.name.endsWith(`:${roomId}`)) {
            return key.name;
        }
    }
    return null;
}