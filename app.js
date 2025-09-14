const express = require('express');
const http = require('http');
const { v4: uuidv4 } = require('uuid');
const app = express();
const server = http.createServer(app);
const io = require('socket.io')(server);

const PORT = process.env.PORT || 3000;

// Serve static files from /public
app.use(express.static('public'));

// Redirect to a new room with a random UUID
app.get('/room', (req, res) => {
  res.redirect(`/room/${uuidv4()}`);
});

// Serve the index.html for a specific room
app.get('/room/:roomId', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

// Socket.io logic
io.on('connection', (socket) => {
  console.log('socket connected', socket.id);

  socket.on('join-room', (roomId, userName) => {
    if (!roomId) return;

    socket.join(roomId);
    socket.data.name = userName || 'Anonymous';
    console.log(`${socket.id} joined room ${roomId} as "${socket.data.name}"`);

    // Get existing clients in room (excluding self)
    const clientsSet = io.sockets.adapter.rooms.get(roomId) || new Set();
    const clients = Array.from(clientsSet).filter(id => id !== socket.id);

    // Send the list of existing users to new user
    socket.emit('existing-users', clients);

    // Notify others in the room
    socket.to(roomId).emit('user-joined', { socketId: socket.id, name: socket.data.name });

    // Forward WebRTC signals
    socket.on('signal', (payload) => {
      const { to } = payload;
      if (!to) return;
      io.to(to).emit('signal', payload);
    });

    // Handle chat messages
    socket.on('message', ({ room, msg }) => {
      if (!room || !msg) return;
      io.to(room).emit('message', { from: socket.id, name: socket.data.name, msg });
    });

    // Handle disconnect
    socket.on('disconnect', () => {
      console.log(`${socket.id} disconnected from room ${roomId}`);
      socket.to(roomId).emit('user-left', { socketId: socket.id, name: socket.data.name });
    });
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
