const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();

// Enable CORS for Express routes if you add REST API endpoints later
app.use(cors());

const server = http.createServer(app);

// Initialize Socket.io and allow all origins (*)
const io = new Server(server, {
  allowEIO3,
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// In-memory store for connected devices
// Key: device_id (ESP32 MAC) -> Value: socket.id
const onlineDevices = new Map();

// Basic health check route for Railway to ping
app.get('/', (req, res) => {
  res.send('IoT Gateway Server is actively running.');
});

// Handle Socket.io connections
io.on('connection', (socket) => {
  // 1. Log client connection
  console.log(`[+] Client connected with socket ID: ${socket.id}`);

  // 2. Handle ESP32 Registration
  socket.on('register_device', (payload) => {
    if (payload && payload.device_id) {
      const { device_id } = payload;
      
      // Save device_id and its socket.id to the map
      onlineDevices.set(device_id, socket.id);
      
      // Bind the device_id to the socket object for easy cleanup on disconnect
      socket.device_id = device_id; 
      
      console.log(`Device registered: ${device_id}`);
    } else {
      console.warn(`[!] Invalid register_device payload received from ${socket.id}`);
    }
  });

  // 3. Handle WebApp sending command
  socket.on('send_command', (payload) => {
    if (payload && payload.device_id && payload.action) {
      const { device_id, action } = payload;
      const targetSocketId = onlineDevices.get(device_id);

      if (targetSocketId) {
        // Device is found and online, forward the command to that specific ESP32
        io.to(targetSocketId).emit('command', { action });
        console.log(`Command '${action}' sent to device: ${device_id}`);
      } else {
        // Device is offline or not registered
        console.log(`[!] Failed to send command. Device offline: ${device_id}`);
        
        // Emit an error message back to the WebApp that sent the command
        socket.emit('error', { 
          message: `Device ${device_id} is currently offline.`,
          device_id 
        });
      }
    } else {
      console.warn(`[!] Invalid send_command payload received from ${socket.id}`);
    }
  });

  // 4. Handle Disconnections
  socket.on('disconnect', () => {
    // Check if the disconnected socket belonged to an ESP32
    if (socket.device_id) {
      // Ensure the socket hasn't been overwritten by a rapid reconnect
      if (onlineDevices.get(socket.device_id) === socket.id) {
        onlineDevices.delete(socket.device_id);
        console.log(`Device disconnected: ${socket.device_id}`);
      }
    }
    console.log(`[-] Client disconnected: ${socket.id}`);
  });
});

// Use process.env.PORT as required by Railway, defaulting to 3000 locally
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`IoT Gateway Server listening on port ${PORT}`);
});
