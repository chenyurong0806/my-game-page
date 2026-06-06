export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const action = url.searchParams.get('action');
    const gameId = url.searchParams.get('gameId');
    const roomId = url.searchParams.get('roomId');

    if (!env.GAME_KV) {
        return new Response(JSON.stringify({ error: "Cloudflare KV 未绑定" }), { status: 500 });
    }

    // 1. 获取房间列表 (只有大厅才需要使用 list，这是正常的)
    if (action === 'list' && request.method === 'GET') {
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
        const { gameId: bodyGameId } = await request.json();
        const randomRoomId = Math.floor(100000 + Math.random() * 900000).toString(); // 随机6位房间号
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
        // 直接精准写入
        await env.GAME_KV.put(`room:${bodyGameId}:${randomRoomId}`, JSON.stringify(newRoom), { expirationTtl: 3600 });
        return new Response(JSON.stringify({ roomId: randomRoomId }), { headers: { 'Content-Type': 'application/json' } });
    }

    // 3. 加入房间 (P2 进入)
    if (action === 'join' && request.method === 'POST') {
        const { roomId: bodyRoomId, gameId: bodyGameId } = await request.json();
        const kvKey = `room:${bodyGameId}:${bodyRoomId}`;
        
        const room = await env.GAME_KV.get(kvKey, { type: 'json' });
        if (!room) return new Response("房间不存在", { status: 404 });

        if (room.status === 'waiting') {
            room.p2 = 'joined';
            room.status = 'playing'; 
            await env.GAME_KV.put(kvKey, JSON.stringify(room), { expirationTtl: 3600 });
        }
        return new Response(JSON.stringify(room), { headers: { 'Content-Type': 'application/json' } });
    }

    // 4. 获取单个房间状态 (不再使用 list 扫描，改成直接精准 get 获取)
    if (action === 'status' && request.method === 'GET') {
        const kvKey = `room:${gameId}:${roomId}`;
        const room = await env.GAME_KV.get(kvKey, { type: 'json' });
        if (!room) return new Response("房间不存在", { status: 404 });
        return new Response(JSON.stringify(room), { headers: { 'Content-Type': 'application/json' } });
    }

    // 5. 核心对战逻辑：点击动作
    if (action === 'click' && request.method === 'POST') {
        const { roomId: bodyRoomId, gameId: bodyGameId, player } = await request.json();
        const kvKey = `room:${bodyGameId}:${bodyRoomId}`;

        const room = await env.GAME_KV.get(kvKey, { type: 'json' });
        if (!room) return new Response("房间不存在", { status: 404 });
        if (room.status !== 'playing') return new Response("游戏未开始或已结束", { status: 400 });

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
        return new Response(JSON.stringify(room), { headers: { 'Content-Type': 'application/json' } });
    }

    return new Response("未知的操作", { status: 400 });
}
