# Xiaozhi AI - Vietnamese Music MCP Server (Zing MP3)

Máy chủ MCP Server Zing MP3 cho trợ lý Xiaozhi AI ESP32.

## Tính năng
- Tìm kiếm và phát nhạc Việt Nam trực tiếp từ Zing MP3 (không qua server trung gian).
- Hỗ trợ đầy đủ bộ giải mã `Esp32Music` (Helix MP3 decoder) trên ESP32.
- Chuẩn giao thức MCP Tools WebSocket kết nối trực tiếp tới `api.xiaozhi.me`.
- Giao diện Web Portal hiện đại để quản lý thiết bị, token và trạng thái kết nối.
- Tự động kết nối lại khi mất mạng hoặc khởi động lại server.

## Triển khai lên Render (Miễn phí 24/7)
1. Fork hoặc Push repository này lên GitHub của bạn.
2. Đăng nhập vào Render (https://render.com), tạo mới **Web Service**.
3. Chọn repository này.
4. Cấu hình:
   - **Environment**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `node index.js`
5. Bấm **Deploy**.
6. Sau khi deploy xong, truy cập URL Render để nhập token MCP Xiaozhi của bạn.
