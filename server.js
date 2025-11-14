const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const rooms = new Map();
const connections = new Map();

// Serve a simple test page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// REST endpoint to create a room
app.post('/api/create-room', (req, res) => {
    const roomId = generateRoomId();
    rooms.set(roomId, {
        host: null,
        guest: null,
        createdAt: Date.now()
    });
    
    console.log(`Room created: ${roomId}`);
    res.json({ roomId, success: true });
});

// REST endpoint to check room status
app.get('/api/room/:roomId', (req, res) => {
    const roomId = req.params.roomId;
    const room = rooms.get(roomId);
    
    if (!room) {
        return res.status(404).json({ error: 'Room not found' });
    }
    
    res.json({
        roomId,
        hostConnected: !!room.host,
        guestConnected: !!room.guest,
        playerCount: (room.host ? 1 : 0) + (room.guest ? 1 : 0)
    });
});

// WebSocket connection handling
wss.on('connection', (ws, request) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const roomId = url.searchParams.get('room');
    const playerId = url.searchParams.get('player');
    const isHost = url.searchParams.get('host') === 'true';

    console.log(`New connection: room=${roomId}, player=${playerId}, isHost=${isHost}`);

    if (!roomId || !playerId) {
        ws.close(1008, 'Missing room or player ID');
        return;
    }

    // Initialize room if it doesn't exist
    if (!rooms.has(roomId)) {
        rooms.set(roomId, { host: null, guest: null, createdAt: Date.now() });
    }

    const room = rooms.get(roomId);
    const connectionId = `${roomId}-${playerId}`;
    connections.set(connectionId, ws);

    if (isHost) {
        if (room.host && room.host.ws.readyState === WebSocket.OPEN) {
            ws.close(1008, 'Room already has a host');
            return;
        }
        room.host = { ws, playerId };
        console.log(`Host ${playerId} joined room ${roomId}`);
    } else {
        if (room.guest && room.guest.ws.readyState === WebSocket.OPEN) {
            ws.close(1008, 'Room already has a guest');
            return;
        }
        room.guest = { ws, playerId };
        console.log(`Guest ${playerId} joined room ${roomId}`);
        
        // Notify host that guest joined
        if (room.host && room.host.ws.readyState === WebSocket.OPEN) {
            room.host.ws.send(JSON.stringify({ 
                type: 'player-joined',
                playerId: playerId
            }));
            console.log(`Notified host of room ${roomId} that guest joined`);
        }
    }

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            console.log(`Message from ${playerId} in room ${roomId}: ${data.type}`);
            
            // Route message to the other player
            const target = isHost ? room.guest : room.host;
            if (target && target.ws.readyState === WebSocket.OPEN) {
                target.ws.send(message);
                console.log(`Message relayed to ${target.playerId}`);
            } else {
                console.log(`Target player not found or not connected in room ${roomId}`);
                
                // Notify sender that target is not available
                ws.send(JSON.stringify({
                    type: 'error',
                    message: 'Other player is not connected'
                }));
            }
        } catch (error) {
            console.error('Error parsing message:', error);
        }
    });

    ws.on('close', (code, reason) => {
        console.log(`Connection closed for player ${playerId} in room ${roomId}: ${code} - ${reason}`);
        
        connections.delete(connectionId);
        
        if (isHost) {
            room.host = null;
            // Notify guest if they're still connected
            if (room.guest && room.guest.ws.readyState === WebSocket.OPEN) {
                room.guest.ws.send(JSON.stringify({
                    type: 'host-disconnected'
                }));
            }
        } else {
            room.guest = null;
            // Notify host if they're still connected
            if (room.host && room.host.ws.readyState === WebSocket.OPEN) {
                room.host.ws.send(JSON.stringify({
                    type: 'guest-disconnected'
                }));
            }
        }
        
        // Clean up empty rooms after 1 hour
        if (!room.host && !room.guest) {
            setTimeout(() => {
                if (rooms.get(roomId) && !rooms.get(roomId).host && !rooms.get(roomId).guest) {
                    rooms.delete(roomId);
                    console.log(`Room ${roomId} cleaned up`);
                }
            }, 3600000); // 1 hour
        }
    });

    ws.on('error', (error) => {
        console.error(`WebSocket error for player ${playerId} in room ${roomId}:`, error);
    });

    // Send connection confirmation
    ws.send(JSON.stringify({
        type: 'connected',
        roomId: roomId,
        playerId: playerId,
        isHost: isHost
    }));
});

function generateRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Clean up old rooms periodically (older than 2 hours)
setInterval(() => {
    const now = Date.now();
    let cleanedCount = 0;
    
    for (const [roomId, room] of rooms.entries()) {
        if (now - room.createdAt > 7200000) { // 2 hours
            if (room.host && room.host.ws.readyState === WebSocket.OPEN) {
                room.host.ws.close(1000, 'Room expired');
            }
            if (room.guest && room.guest.ws.readyState === WebSocket.OPEN) {
                room.guest.ws.close(1000, 'Room expired');
            }
            rooms.delete(roomId);
            cleanedCount++;
        }
    }
    
    if (cleanedCount > 0) {
        console.log(`Cleaned up ${cleanedCount} expired rooms`);
    }
}, 600000); // Check every 10 minutes

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Chess signaling server running on port ${PORT}`);
    console.log(`WebSocket endpoint: ws://localhost:${PORT}`);
    console.log(`HTTP endpoint: http://localhost:${PORT}`);
});