export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const action = url.searchParams.get('action');
    const gameId = url.searchParams.get('gameId');
    const roomId = url.searchParams.get('roomId');

    // 【核心修复】定义绝对禁止缓存的响应头，彻底击碎浏览器和CDN缓存
    const headers = {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
        'Pragma': 'no-cache',
        'Expires': '0'
    };

    if (!env.GAME_KV) {
        return new Response(JSON.stringify({ error: "Cloudflare KV 未绑定" }), { status: 500, headers });
    }

    // 1. 获取房间列表
    if (action === 'list' && request.method === 'GET') {
        const list = await env.GAME_KV.list({ prefix: `room:${gameId}:` });
        const rooms = [];
        for (const key of list.keys) {
            const val = await env.GAME_KV.get(key.name, { type: 'json' });
            if (val) rooms.push({ id: val.id, status: val.status });
        }
        return new Response(JSON.stringify(rooms), { headers });
    }

    // 2. 创建新房间
    if (action === 'create' && request.method === 'POST') {
        const { gameId: bodyGameId } = await request.json();
        const randomRoomId = Math.floor(100000 + Math.random() * 900000).toString();
        const newRoom = {
            id: randomRoomId,
            gameId: bodyGameId,
            status: 'waiting',
            p1: 'joined',
            p2: null,
            p1Score: 0,
            p2Score: 0,
            winner: null
        };
        await env.GAME_KV.put(`room:${bodyGameId}:${randomRoomId}`, JSON.stringify(newRoom), { expirationTtl: 3600 });
        return new Response(JSON.stringify({ roomId: randomRoomId }), { headers });
    }

    // 3. 加入房间 (P2 进入)
    if (action === 'join' && request.method === 'POST') {
        const { roomId: bodyRoomId, gameId: bodyGameId } = await request.json();
        const kvKey = `room:${bodyGameId}:${bodyRoomId}`;
        
        const room = await env.GAME_KV.get(kvKey, { type: 'json' });
        if (!room) return new Response(JSON.stringify({ error: "房间不存在" }), { status: 404, headers });

        if (room.status === 'waiting') {
            room.p2 = 'joined';
            room.status = 'playing'; 
            await env.GAME_KV.put(kvKey, JSON.stringify(room), { expirationTtl: 3600 });
        }
        return new Response(JSON.stringify(room), { headers });
    }

    // 4. 获取单个房间状态 (精准 GET)
    if (action === 'status' && request.method === 'GET') {
        const kvKey = `room:${gameId}:${roomId}`;
        const room = await env.GAME_KV.get(kvKey, { type: 'json' });
        if (!room) return new Response(JSON.stringify({ error: "房间不存在" }), { status: 404, headers });
        return new Response(JSON.stringify(room), { headers });
    }

    // 5. 核心对战逻辑：点击动作
    if (action === 'click' && request.method === 'POST') {
        const { roomId: bodyRoomId, gameId: bodyGameId, player } = await request.json();
        const kvKey = `room:${bodyGameId}:${bodyRoomId}`;

        const room = await env.GAME_KV.get(kvKey, { type: 'json' });
        if (!room) return new Response(JSON.stringify({ error: "房间不存在" }), { status: 404, headers });
        if (room.status !== 'playing') return new Response(JSON.stringify({ error: "游戏未开始或已结束" }), { status: 400, headers });

        if (player === 'p1') room.p1Score += 1;
        if (player === 'p2') room.p2Score += 1;

        if (room.p1Score >= 30) {
            room.status = 'finished';
            room.winner = 'p1';
        } else if (room.p2Score >= 30) {
            room.status = 'finished';
            room.winner = 'p2';
        }

        await env.GAME_KV.put(kvKey, JSON.stringify(room), { expirationTtl: 3600 });
        return new Response(JSON.stringify(room), { headers });
    }

    return new Response(JSON.stringify({ error: "未知的操作" }), { status: 400, headers });
}
