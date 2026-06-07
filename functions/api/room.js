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

    // 检查安全绑定
    if (!env.GAME_KV) {
        return new Response(JSON.stringify({ error: "Cloudflare KV 未绑定" }), { status: 500, headers });
    }

    // 1. 获取活跃房间列表（只返回对应游戏的房间）
    if (action === 'list' && request.method === 'GET') {
        const list = await env.GAME_KV.list({ prefix: `room:${gameId}:meta:` });
        const rooms = [];
        for (const key of list.keys) {
            const val = await env.GAME_KV.get(key.name, { type: 'json' });
            // 过滤：大厅只展示“正在等待”或者“游戏中”的房间，体验更好
            if (val && val.status !== 'finished') {
                rooms.push({ id: val.id, status: val.status });
            }
        }
        return new Response(JSON.stringify(rooms), { headers });
    }

    // 2. 创建新房间（纯粹的元数据初始化，不再创建分数键）
    if (action === 'create' && request.method === 'POST') {
        const { gameId: bodyGameId } = await request.json();
        const randomRoomId = Math.floor(100000 + Math.random() * 900000).toString();
        
        const metaKey = `room:${bodyGameId}:meta:${randomRoomId}`;
        const meta = { 
            id: randomRoomId, 
            gameId: bodyGameId, 
            status: 'waiting', 
            p1: 'joined', 
            p2: null 
        };
        
        // 房间基础状态写入 KV（1小时后自动过期释放空间）
        await env.GAME_KV.put(metaKey, JSON.stringify(meta), { expirationTtl: 3600 });

        return new Response(JSON.stringify({ roomId: randomRoomId }), { headers });
    }

    // 3. 加入房间 (P2 点击进入)
    if (action === 'join' && request.method === 'POST') {
        const { roomId: bodyRoomId, gameId: bodyGameId } = await request.json();
        const metaKey = `room:${bodyGameId}:meta:${bodyRoomId}`;
        
        const meta = await env.GAME_KV.get(metaKey, { type: 'json' });
        if (!meta) return new Response(JSON.stringify({ error: "房间不存在" }), { status: 404, headers });

        // 如果是等待中，更新状态为游戏中
        if (meta.status === 'waiting') {
            meta.p2 = 'joined';
            meta.status = 'playing'; 
            await env.GAME_KV.put(metaKey, JSON.stringify(meta), { expirationTtl: 3600 });
        }
        return new Response(JSON.stringify(meta), { headers });
    }

    // 4. 获取单个房间状态 (纯粹获取元数据，用于前端同步身份)
    if (action === 'status' && request.method === 'GET') {
        const metaKey = `room:${gameId}:meta:${roomId}`;
        const meta = await env.GAME_KV.get(metaKey, { type: 'json' });

        if (!meta) return new Response(JSON.stringify({ error: "房间不存在" }), { status: 404, headers });

        // 直接返回最纯净的房间元数据
        return new Response(JSON.stringify(meta), { headers });
    }

    return new Response(JSON.stringify({ error: "未知的操作" }), { status: 400, headers });
}
