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
      const { device_id, action, sub_id } = payload;
      const targetSocketId = onlineDevices.get(device_id);

      if (targetSocketId) {
        // Device is found and online, forward the command to that specific ESP32
        io.to(targetSocketId).emit('command', { action, sub_id });
      } else {
        // Device is offline or not registered
        socket.emit('error', { 
          message: `Device ${device_id} is currently offline.`,
          device_id 
        });
      }
    }
  });

  // 4. Handle Disconnections
  socket.on('disconnect', (reason) => {
    
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

  // 5. App yêu cầu thông tin cấu hình/khả năng của từng thiết bị khi Add Device
  socket.on('get_device_info', (payload) => {
    if (payload && payload.device_id) {
      const isOnline = onlineDevices.has(payload.device_id);
      // Nếu chưa online -> Không thể lấy info hoặc biết thiết bị
      if (!isOnline) {
        socket.emit('device_info_result', {
          device_id: payload.device_id,
          error: 'Thiết bị hiện không kết nối, hãy nối mạng cho thiết bị trước.'
        });
        return;
      }
      
      // Giả lập: hiện thời nhận diện ESP32 multi-gang 4 sub_id như trong code Arduino
      // Trong tương lai có thể bắt ESP32 gửi capability khi connect
      socket.emit('device_info_result', {
        device_id: payload.device_id,
        isMultiDevice: true,
        subIds: [1, 2, 3, 4]
      });
    }
  });

  // Nhận cập nhật lịch trình từ Web Client
  socket.on("update_schedules", (payload) => {
    if (payload && payload.device_id) {
      deviceSchedules.set(payload.device_id, payload.schedules || []);
      console.log(`[LỊCH TRÌNH NODE] Cập nhật ${payload.schedules?.length || 0} lịch cho thiết bị ${payload.device_id}`);
    }
  });
});

// Lưu trữ lịch trình in-memory
const deviceSchedules = new Map();

// THỰC THI LỊCH TRÌNH MỖI 30 GIÂY
setInterval(() => {
  const now = new Date();
  const currentHour = now.getHours().toString().padStart(2, '0');
  const currentMinute = now.getMinutes().toString().padStart(2, '0');
  const currentTimeStr = `${currentHour}:${currentMinute}`;
  const currentDay = now.getDay(); 

  // Kiểm tra từng thiết bị
  deviceSchedules.forEach((schedules, device_id) => {
    if (!Array.isArray(schedules)) return;

    // Không gửi lệnh nếu thiết bị offline
    const targetSocketId = onlineDevices.get(device_id);
    if (!targetSocketId) return;

    schedules.forEach((sched) => {
      if (sched.active === false) return;

      let shouldRun = false;
      if (sched.repeat === 'Một lần' || sched.repeat === 'Hàng ngày') {
        shouldRun = true;
      } else if (sched.repeat === 'Tùy chỉnh') {
        shouldRun = sched.customDays?.includes(currentDay) || false;
      }

      if (shouldRun) {
        if (sched.timeOn === currentTimeStr) {
          console.log(`[LỊCH TRÌNH NODE] Phát lệnh BẬT -> ${device_id} cổng ${sched.subId}`);
          io.to(targetSocketId).emit('command', { action: 'on', sub_id: sched.subId });
        }
        if (sched.timeOff === currentTimeStr) {
          console.log(`[LỊCH TRÌNH NODE] Phát lệnh TẮT -> ${device_id} cổng ${sched.subId}`);
          io.to(targetSocketId).emit('command', { action: 'off', sub_id: sched.subId });
        }
      }
    });
  });
}, 30000);

// Use process.env.PORT as required by Railway, defaulting to 3000 locally
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`IoT Gateway Server listening on port ${PORT}`);
});
