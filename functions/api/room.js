export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const action = url.searchParams.get('action');
    const gameId = url.searchParams.get('gameId');
    const roomId = url.searchParams.get('roomId');

    const headers = {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
    };

    if (!env.GAME_KV) {
        return new Response(JSON.stringify({ error: "Cloudflare KV 未绑定" }), { status: 500, headers });
    }

    // 1. 获取房间列表
    if (action === 'list' && request.method === 'GET') {
        const list = await env.GAME_KV.list({ prefix: `room:${gameId}:meta:` });
        const rooms = [];
        for (const key of list.keys) {
            const val = await env.GAME_KV.get(key.name, { type: 'json' });
            if (val) rooms.push({ id: val.id, status: val.status });
        }
        return new Response(JSON.stringify(rooms), { headers });
    }

    // 2. 创建新房间（解耦存储：元数据与分数独立）
    if (action === 'create' && request.method === 'POST') {
        const { gameId: bodyGameId } = await request.json();
        const randomRoomId = Math.floor(100000 + Math.random() * 900000).toString();
        
        const metaKey = `room:${bodyGameId}:meta:${randomRoomId}`;
        const p1Key = `room:${bodyGameId}:score:${randomRoomId}:p1`;
        const p2Key = `room:${bodyGameId}:score:${randomRoomId}:p2`;

        const meta = { id: randomRoomId, gameId: bodyGameId, status: 'waiting', p1: 'joined', p2: null, winner: null };
        
        // 并行初始化写入
        await Promise.all([
            env.GAME_KV.put(metaKey, JSON.stringify(meta), { expirationTtl: 3600 }),
            env.GAME_KV.put(p1Key, "0", { expirationTtl: 3600 }),
            env.GAME_KV.put(p2Key, "0", { expirationTtl: 3600 })
        ]);

        return new Response(JSON.stringify({ roomId: randomRoomId }), { headers });
    }

    // 3. 加入房间 (P2 进入)
    if (action === 'join' && request.method === 'POST') {
        const { roomId: bodyRoomId, gameId: bodyGameId } = await request.json();
        const metaKey = `room:${bodyGameId}:meta:${bodyRoomId}`;
        
        const meta = await env.GAME_KV.get(metaKey, { type: 'json' });
        if (!meta) return new Response(JSON.stringify({ error: "房间不存在" }), { status: 404, headers });

        if (meta.status === 'waiting') {
            meta.p2 = 'joined';
            meta.status = 'playing'; 
            await env.GAME_KV.put(metaKey, JSON.stringify(meta), { expirationTtl: 3600 });
        }
        return new Response(JSON.stringify(meta), { headers });
    }

    // 4. 获取单个房间状态 (多键值联合精准获取)
    if (action === 'status' && request.method === 'GET') {
        const metaKey = `room:${gameId}:meta:${roomId}`;
        const p1Key = `room:${gameId}:score:${roomId}:p1`;
        const p2Key = `room:${gameId}:score:${roomId}:p2`;

        const [meta, p1ScoreStr, p2ScoreStr] = await Promise.all([
            env.GAME_KV.get(metaKey, { type: 'json' }),
            env.GAME_KV.get(p1Key),
            env.GAME_KV.get(p2Key)
        ]);

        if (!meta) return new Response(JSON.stringify({ error: "房间不存在" }), { status: 404, headers });

        // 组装最新状态返回前端
        const roomData = {
            ...meta,
            p1Score: parseInt(p1ScoreStr || "0", 10),
            p2Score: parseInt(p2ScoreStr || "0", 10)
        };
        return new Response(JSON.stringify(roomData), { headers });
    }

    // 5. 核心防踩踏对抗逻辑：绝对值自增上报
    if (action === 'click' && request.method === 'POST') {
        const { roomId: bodyRoomId, gameId: bodyGameId, player, totalClicks } = await request.json();
        
        const metaKey = `room:${bodyGameId}:meta:${bodyRoomId}`;
        const scoreKey = `room:${bodyGameId}:score:${bodyRoomId}:${player}`;

        const [currentScoreStr, meta] = await Promise.all([
            env.GAME_KV.get(scoreKey),
            env.GAME_KV.get(metaKey, { type: 'json' })
        ]);

        if (!meta) return new Response(JSON.stringify({ error: "房间不存在" }), { status: 404, headers });
        if (meta.status !== 'playing') return new Response(JSON.stringify({ error: "游戏未在进行中" }), { status: 400, headers });

        const currentScore = parseInt(currentScoreStr || "0", 10);

        // 【强力防倒退保护】只有当前前端上报的绝对值大于云端已有值，才被允许写入
        if (totalClicks > currentScore) {
            await env.GAME_KV.put(scoreKey, totalClicks.toString(), { expirationTtl: 3600 });
            
            // 裁决胜负
            if (totalClicks >= 30) {
                meta.status = 'finished';
                meta.winner = player;
                await env.GAME_KV.put(metaKey, JSON.stringify(meta), { expirationTtl: 3600 });
            }
        }
        return new Response(JSON.stringify({ success: true }), { headers });
    }

    return new Response(JSON.stringify({ error: "未知的操作" }), { status: 400, headers });
}
