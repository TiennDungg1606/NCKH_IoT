require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();

// Kết nối MongoDB (sẽ dùng chung với URI bên Next.js)
const MONGODB_URI = process.env.MONGODB_URI; 
mongoose.connect(MONGODB_URI)
  .then(() => console.log('🔥 MongoDB Connected in Node.js Gateway server'))
  .catch(err => console.error('Lỗi kết nối MongoDB trong Server Node:', err));

// Khởi tạo Device Schema cơ bản để query trực tiếp dữ liệu thiết bị
const DeviceSchema = new mongoose.Schema({
  deviceId: { type: String, required: true },
  schedules: { type: Array, default: [] }
}, { strict: false }); // strict: false để tự động bỏ qua các trường không khai báo ở đây
const Device = mongoose.models.Device || mongoose.model('Device', DeviceSchema);

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

  // Báo update lịch trình từ Web Client - Server giờ đây tự gọi DB, không lưu Map in-memory nữa
  socket.on("update_schedules", (payload) => {
    if (payload && payload.device_id) {
      console.log(`[LỊCH TRÌNH NODE] Cập nhật thiết bị ${payload.device_id} (Server tự fetch từ MongoDB)`);
    }
  });
});

// THỰC THI LỊCH TRÌNH MỖI 30 GIÂY AUTO
setInterval(async () => {
  const now = new Date();
  const currentHour = now.getHours().toString().padStart(2, '0');
  const currentMinute = now.getMinutes().toString().padStart(2, '0');
  const currentTimeStr = `${currentHour}:${currentMinute}`;
  const currentDay = now.getDay(); 

  // Lấy các thiết bị ĐANG ONLINE (không gọi Mongo nếu không có ESP32 nào cắm điện)
  const onlineDeviceIds = Array.from(onlineDevices.keys());
  if (onlineDeviceIds.length === 0) return;

  try {
    // 1. CHỈ FIND NHỮNG THIẾT BỊ ĐANG CÓ MẶT TRÊN MẠNG XUỐNG RA SET SCHEDULES
    const devices = await Device.find({ deviceId: { $in: onlineDeviceIds } });

    // 2. DUYỆT TỪNG THIẾT BỊ TỪ DATABASE
    devices.forEach((device) => {
      const device_id = device.deviceId;
      const schedules = device.schedules;
      
      if (!Array.isArray(schedules) || schedules.length === 0) return;

      const targetSocketId = onlineDevices.get(device_id);
      if (!targetSocketId) return; // double check lỡ vừa fetch nó die 

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
            console.log(`[LỊCH TRÌNH AUTO MONGODB] Phát lệnh BẬT -> ${device_id} cổng ${sched.subId}`);
            io.to(targetSocketId).emit('command', { action: 'on', sub_id: sched.subId });
          }
          if (sched.timeOff === currentTimeStr) {
            console.log(`[LỊCH TRÌNH AUTO MONGODB] Phát lệnh TẮT -> ${device_id} cổng ${sched.subId}`);
            io.to(targetSocketId).emit('command', { action: 'off', sub_id: sched.subId });
          }
        }
      });
    });
  } catch (error) {
    console.error('Lỗi khi fetch dữ liệu từ MongoDB:', error);
  }
}, 30000);

// Use process.env.PORT as required by Railway, defaulting to 3000 locally
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`IoT Gateway Server listening on port ${PORT}`);
});
