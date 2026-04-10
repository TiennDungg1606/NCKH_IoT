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

// Bộ nhớ cục bộ để giữ "dấu chân" các lịch đã chạy trong phút này, tránh dội lệnh do quét 30s/lần
const executedSchedules = new Set();
setInterval(() => executedSchedules.clear(), 3600000); // Clear bộ lọc rác mỗi 1 giờ để nhẹ RAM

// GIAI ĐOẠN B: VÒNG LẶP KIỂM TRA MỖI 30 GIÂY
setInterval(async () => {
  // KHẮC PHỤC TIMEZONE: Ép cứng lấy mốc giờ Việt Nam (UTC+7) trên bất kỳ máy chủ nào
  const vnTimeStr = new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false }); 
  const timeMatch = vnTimeStr.match(/(\d+):(\d+):(\d+)/);
  if (!timeMatch) return;
  
  const currentHour = timeMatch[1].padStart(2, '0');
  const currentMinute = timeMatch[2].padStart(2, '0');
  const currentTimeStr = `${currentHour}:${currentMinute}`;
  
  // Lấy Ngày/Thứ chuẩn theo Việt Nam (0: CN, 1: T2, ...)
  const vnDateObj = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" }));
  const currentDay = vnDateObj.getDay(); 

  const onlineDeviceIds = Array.from(onlineDevices.keys());
  if (onlineDeviceIds.length === 0) return;

  try {
    // Truy vấn MongoDB chỉ lấy các thiết bị ĐANG CẮM ĐIỆN ⚡
    const devices = await Device.find({ deviceId: { $in: onlineDeviceIds } });

    // Quét từng thiết bị
    for (const device of devices) {
      const device_id = device.deviceId;
      let schedules = device.schedules;
      let dbNeedsSave = false;

      if (!Array.isArray(schedules) || schedules.length === 0) continue;

      const targetSocketId = onlineDevices.get(device_id);
      if (!targetSocketId) continue; 

      // Quét từng lịch hẹn
      for (let i = 0; i < schedules.length; i++) {
        let sched = schedules[i];

        if (sched.active === false) continue;

        // GIAI ĐOẠN C: Đánh giá điều kiện
        let shouldRun = false;
        if (sched.repeat === 'Một lần' || sched.repeat === 'Hàng ngày') {
          shouldRun = true;
        } else if (sched.repeat === 'Tùy chỉnh') {
          shouldRun = sched.customDays?.includes(currentDay) || false;
        }

        if (shouldRun) {
          // Lệnh BẬT
          if (sched.timeOn === currentTimeStr) {
             const execKey = `${device_id}_ON_${sched.id || i}_${currentTimeStr}`;
             if (!executedSchedules.has(execKey)) { // Tránh bắn 2 lần
                executedSchedules.add(execKey);
                console.log(`[AUTO] BẬT -> ${device_id} cổng ${sched.subId} (Giờ VN: ${currentTimeStr})`);
                io.to(targetSocketId).emit('command', { action: 'on', sub_id: sched.subId });
                
                // Cập nhật Inactive nếu Một Lần (chỉ cập nhật nếu KHÔNG CÓ lịch tắt phía sau chờ)
                if (sched.repeat === 'Một lần' && !sched.timeOff) {
                  sched.active = false;
                  dbNeedsSave = true;
                }
             }
          }

          // Lệnh TẮT
          if (sched.timeOff === currentTimeStr) {
             const execKey = `${device_id}_OFF_${sched.id || i}_${currentTimeStr}`;
             if (!executedSchedules.has(execKey)) {
                executedSchedules.add(execKey);
                console.log(`[AUTO] TẮT -> ${device_id} cổng ${sched.subId} (Giờ VN: ${currentTimeStr})`);
                io.to(targetSocketId).emit('command', { action: 'off', sub_id: sched.subId });
                
                // Một lần tắt là hoàn thành vòng đời -> Inactive
                if (sched.repeat === 'Một lần') {
                  sched.active = false;
                  dbNeedsSave = true;
                }
             }
          }
        }
      } // Kết thúc lặp Cùng một Thiết bị
      
      // Nếu có sự kiện Một lần bị Inactive -> UPDATE LẠI VÀO MONGODB
      if (dbNeedsSave) {
        await Device.updateOne(
          { deviceId: device_id },
          { $set: { schedules: schedules } }
        );
        console.log(`[AUTO] Đã huỷ lịch "Một lần" trên MongoDB cho thiết bị: ${device_id}`);
      }
    }
  } catch (error) {
    console.error('Lỗi truy vấn MongoDB vòng lặp:', error);
  }
}, 30000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`IoT Gateway Server listening on port ${PORT}`);
});
