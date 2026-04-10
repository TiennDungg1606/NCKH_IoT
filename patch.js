const fs = require('fs');
const filePath = 'server.js';
const code = fs.readFileSync(filePath, 'utf-8');

const splitIndex = code.indexOf('// TH');

if (splitIndex !== -1) {
  const keep = code.substring(0, splitIndex);
  
  const newPart = `// Bộ nhớ cục bộ để giữ "dấu chân" các lịch đã chạy trong phút này, tránh dội lệnh do quét 30s/lần
const executedSchedules = new Set();
setInterval(() => executedSchedules.clear(), 3600000); // Clear bộ lọc rác mỗi 1 giờ để nhẹ RAM

// GIAI ĐOẠN B: VÒNG LẶP KIỂM TRA MỖI 30 GIÂY
setInterval(async () => {
  // KHẮC PHỤC TIMEZONE: Ép cứng lấy mốc giờ Việt Nam (UTC+7) trên bất kỳ máy chủ nào
  const vnTimeStr = new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false }); 
  const timeMatch = vnTimeStr.match(/(\\d+):(\\d+):(\\d+)/);
  if (!timeMatch) return;
  
  const currentHour = timeMatch[1].padStart(2, '0');
  const currentMinute = timeMatch[2].padStart(2, '0');
  const currentTimeStr = \`\${currentHour}:\${currentMinute}\`;
  
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
             const execKey = \`\${device_id}_ON_\${sched.id || i}_\${currentTimeStr}\`;
             if (!executedSchedules.has(execKey)) { // Tránh bắn 2 lần
                executedSchedules.add(execKey);
                console.log(\`[AUTO] BẬT -> \${device_id} cổng \${sched.subId} (Giờ VN: \${currentTimeStr})\`);
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
             const execKey = \`\${device_id}_OFF_\${sched.id || i}_\${currentTimeStr}\`;
             if (!executedSchedules.has(execKey)) {
                executedSchedules.add(execKey);
                console.log(\`[AUTO] TẮT -> \${device_id} cổng \${sched.subId} (Giờ VN: \${currentTimeStr})\`);
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
        console.log(\`[AUTO] Đã huỷ lịch "Một lần" trên MongoDB cho thiết bị: \${device_id}\`);
      }
    }
  } catch (error) {
    console.error('Lỗi truy vấn MongoDB vòng lặp:', error);
  }
}, 30000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(\`IoT Gateway Server listening on port \${PORT}\`);
});
`;
  
  fs.writeFileSync(filePath, keep + newPart, 'utf-8');
  console.log('Update OK');
} else {
  console.log('Không tìm thấy chốt chặn để update.');
}
