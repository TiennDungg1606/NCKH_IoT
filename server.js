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
  allowEIO3: true, // Allow older Socket.io clients (like ESP32)
  pingInterval: 10000, // Cứ 10s server sẽ ping hỏi thăm client (ESP32)
  pingTimeout: 5000,   // Nếu sau 5s từ lúc ping mà ESP không phản hồi thì coi như ngắt kết nối luôn
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
  // 1. Handle ESP32 Registration
  socket.on('register_device', (payload) => {
    if (payload && payload.device_id) {
      const { device_id } = payload;
      
      // Save device_id and its socket.id to the map
      onlineDevices.set(device_id, socket.id);
      
      // Bind the device_id to the socket object for easy cleanup on disconnect
      socket.device_id = device_id; 
      
      console.log(`Device registered: ${device_id}`);
      
      // Phát sự kiện cho tất cả các Web Client biết ESP32 này đã online
      io.emit("device_status", { device_id, status: "online" });
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
      } else {
        // Device is offline or not registered
        // Emit an error message back to the WebApp that sent the command
        socket.emit('error', { 
          message: `Device ${device_id} is currently offline.`,
          device_id 
        });
      }
    }
  });

  // 4. Handle Disconnections
  socket.on('disconnect', (reason) => {
    console.log(`[Disconnect] Socket ${socket.id} ngắt kết nối. Lý do: ${reason}`);
    
    // Check if the disconnected socket belonged to an ESP32
    if (socket.device_id) {
      // Ensure the socket hasn't been overwritten by a rapid reconnect
      if (onlineDevices.get(socket.device_id) === socket.id) {
        onlineDevices.delete(socket.device_id);
        console.log(`Device disconnected: ${socket.device_id}`);
        // Phát sự kiện cho tất cả Web Client biết ESP32 này đã offline
        io.emit("device_status", { device_id: socket.device_id, status: "offline" });
      }
    }
  });

  // Client Web App yêu cầu kiểm tra trạng thái thiết bị lúc mới mở trang
  socket.on("check_device_status", (payload) => {
    if (payload && payload.device_id) {
      const isOnline = onlineDevices.has(payload.device_id);
      socket.emit("device_status", { 
        device_id: payload.device_id, 
        status: isOnline ? "online" : "offline" 
      });
    }
  });
});

// Use process.env.PORT as required by Railway, defaulting to 3000 locally
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`IoT Gateway Server listening on port ${PORT}`);
});
