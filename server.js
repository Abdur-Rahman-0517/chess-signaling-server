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
const roomTimeouts = new Map(); // For storing timeout handles

// --- Room Timeout Logic ---

const TIMEOUTS = {
    EMPTY: 5 * 60 * 1000,     // 5 minutes
    ONE_PLAYER: 2 * 60 * 60 * 1000, // 2 hours
    TWO_PLAYERS: 5 * 60 * 60 * 1000 // 5 hours
};

function clearRoomTimeout(roomId) {
    if (roomTimeouts.has(roomId)) {
        clearTimeout(roomTimeouts.get(roomId));
        roomTimeouts.delete(roomId);
    }
}

function closeRoom(roomId) {
    console.log(`Closing room ${roomId} due to timeout.`);
    const room = rooms.get(roomId);
    if (!room) return;

    if (room.host && room.host.ws.readyState === WebSocket.OPEN) {
        room.host.ws.close(1000, 'Room timed out');
    }
    if (room.guest && room.guest.ws.readyState === WebSocket.OPEN) {
        room.guest.ws.close(1000, 'Room timed out');
    }
    
    rooms.delete(roomId);
    roomTimeouts.delete(roomId); // Clean up the handle just in case
}

function updateRoomTimeout(roomId) {
    clearRoomTimeout(roomId); // Clear existing timeout

    const room = rooms.get(roomId);
    if (!room) return; // Room is already deleted

    const hostOnline = room.host && room.host.ws.readyState === WebSocket.OPEN;
    const guestOnline = room.guest && room.guest.ws.readyState === WebSocket.OPEN;

    let timeoutDuration;
    let playerCount = 0;

    if (hostOnline) playerCount++;
    if (guestOnline) playerCount++;

    if (playerCount === 0) {
        timeoutDuration = TIMEOUTS.EMPTY;
        console.log(`Room ${roomId}: 0 players. Setting ${TIMEOUTS.EMPTY / 60000} min timeout.`);
    } else if (playerCount === 1) {
        timeoutDuration = TIMEOUTS.ONE_PLAYER;
        console.log(`Room ${roomId}: 1 player. Setting ${TIMEOUTS.ONE_PLAYER / 3600000} hr timeout.`);
    } else { // playerCount === 2
        timeoutDuration = TIMEOUTS.TWO_PLAYERS;
        console.log(`Room ${roomId}: 2 players. Setting ${TIMEOUTS.TWO_PLAYERS / 3600000} hr timeout.`);
    }

    const timeoutHandle = setTimeout(() => {
        closeRoom(roomId);
    }, timeoutDuration);

    roomTimeouts.set(roomId, timeoutHandle);
}

// --- End Room Timeout Logic ---


// Serve a simple test page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// REST endpoint to check room status (for joining)
app.get('/api/room/:roomId', (req, res) => {
    const roomId = req.params.roomId;
    const room = rooms.get(roomId);
    
    if (!room) {
        return res.status(404).json({ error: 'Room not found' });
    }
    
    const hostConnected = !!room.host && room.host.ws.readyState === WebSocket.OPEN;
    const guestConnected = !!room.guest && room.guest.ws.readyState === WebSocket.OPEN;

    res.json({
        roomId,
        hostConnected: hostConnected,
        guestConnected: guestConnected,
        playerCount: (hostConnected ? 1 : 0) + (guestConnected ? 1 : 0)
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
        if (isHost) {
            rooms.set(roomId, { host: null, guest: null, createdAt: Date.now() });
        } else {
            // Guest trying to join a non-existent room
            ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
            ws.close(1008, 'Room not found');
            return;
        }
    }

    const room = rooms.get(roomId);
    const connectionId = `${roomId}-${playerId}`;
    connections.set(connectionId, ws);

    if (isHost) {
        if (room.host && room.host.ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'error', message: 'Room already has a host' }));
            ws.close(1008, 'Room already has a host');
            return;
        }
        room.host = { ws, playerId };
        console.log(`Host ${playerId} joined room ${roomId}`);
    } else {
        if (room.guest && room.guest.ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'error', message: 'Room is full' }));
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

    // Update timeout on new connection
    updateRoomTimeout(roomId);

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            console.log(`Message from ${playerId} in room ${roomId}: ${data.type}`);
            
            // Route message to the other player
            const target = isHost ? room.guest : room.host;
            if (target && target.ws.readyState === WebSocket.OPEN) {
                target.ws.send(message); // Relay the exact message
                console.log(`Message relayed to ${target.playerId}`);
            } else {
                console.log(`Target player not found or not connected in room ${roomId}`);
                // Don't notify on move, only on error
                if (data.type !== 'move') {
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Other player is not connected'
                    }));
                }
            }
        } catch (error) {
            console.error('Error parsing message:', error);
        }
    });

    ws.on('close', (code, reason) => {
        console.log(`Connection closed for player ${playerId} in room ${roomId}: ${code} - ${reason}`);
        
        connections.delete(connectionId);
        
        // Notify the other player
        if (isHost) {
            room.host = null;
            if (room.guest && room.guest.ws.readyState === WebSocket.OPEN) {
                room.guest.ws.send(JSON.stringify({ type: 'opponent-disconnected' }));
            }
        } else {
            room.guest = null;
            if (room.host && room.host.ws.readyState === WebSocket.OPEN) {
                room.host.ws.send(JSON.stringify({ type: 'opponent-disconnected' }));
            }
        }
        
        // Update timeout on disconnect
        updateRoomTimeout(roomId);
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

// Remove periodic cleanup, timeouts are handled on connect/disconnect
// const PORT = process.env.PORT || 3000; (already defined in your file)
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Chess signaling server running on port ${PORT}`);
    console.log(`WebSocket endpoint: ws://localhost:${PORT}`);
    console.log(`HTTP endpoint: http://localhost:${PORT}`);
});
