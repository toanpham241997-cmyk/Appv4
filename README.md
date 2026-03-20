# VIP TOOL PRO V4 - License Portal Demo

Bộ source này giữ lại phong cách giao diện đỏ/đen, các hiệu ứng nền, card, modal, toast, feature switches và tách luồng lấy key ra **trang Free Key Portal riêng**.

## Luồng hoạt động

1. Người dùng mở `index.html` để đăng nhập bằng key.
2. Nếu chưa có key, họ bấm mở **Free Key Portal**.
3. `free-key.html` tạo phiên mới trên server qua `/api/free/create-session`.
4. Server tạo `verify URL` riêng cho thiết bị hiện tại và gọi API Link4m để rút gọn link.
5. Người dùng vượt link Link4m.
6. Sau khi vượt thành công, Link4m redirect về `/verify` trên server.
7. Server xác thực phiên, cấp hoặc dùng lại key miễn phí 5 giờ theo `clientId` thiết bị.
8. Server redirect lại `free-key.html?verified=1&rid=...`.
9. Portal gọi `/api/free/claim` để lấy key thật và hiển thị ra cho người dùng.
10. Người dùng quay lại app và đăng nhập bằng key đó.

## Cấu trúc project

| File | Vai trò |
|---|---|
| `server.js` | API backend + verify + cấp key |
| `public/index.html` | App chính để đăng nhập |
| `public/free-key.html` | Cổng nhận key riêng |
| `data/store.json` | Lưu keys, sessions, notifications, links |
| `.env.example` | Biến môi trường mẫu |
| `render.yaml` | Cấu hình Render |

## Chạy local

```bash
npm install
cp .env.example .env
npm start
```

Mặc định app chạy ở `http://localhost:3000`.

## Biến môi trường

| Key | Bắt buộc | Mô tả |
|---|---:|---|
| `PORT` | Không | Cổng server |
| `APP_BASE_URL` | Có | URL public của app, ví dụ `https://ten-app.onrender.com` |
| `LINK4M_API_TOKEN` | Có | API token Link4m mới |
| `FREE_KEY_TTL_HOURS` | Không | Số giờ key miễn phí còn hiệu lực, mặc định `5` |
| `SESSION_TTL_MINUTES` | Không | Thời hạn phiên vượt link, mặc định `30` phút |
| `SESSION_SECRET` | Có | Secret ký phiên xác minh |

## Deploy Render

1. Tạo repo GitHub và upload toàn bộ source.
2. Trên Render, chọn **New Web Service**.
3. Kết nối repo này.
4. Render sẽ tự đọc `render.yaml`.
5. Điền các env var cần thiết:
   - `APP_BASE_URL`
   - `LINK4M_API_TOKEN`
   - `SESSION_SECRET`
6. Deploy.

## Lưu ý kỹ thuật

- `clientId` được giữ trong `localStorage`, nên nếu người dùng xoá dữ liệu trình duyệt thì thiết bị sẽ được xem như thiết bị mới.
- `data/store.json` phù hợp để test nhanh. Trên môi trường production, nên thay bằng database thật như PostgreSQL, MySQL hoặc Redis.
- Key miễn phí hiện được giới hạn 1 key còn hiệu lực cho mỗi thiết bị.
- Khi key hết hạn, hệ thống sẽ cho phép tạo key mới bằng cách vượt link lại.

## Đổi nội dung hiển thị

Chỉnh trong `data/store.json`:
- `settings.telegram`
- `settings.zalo`
- `settings.facebook`
- `settings.youtube`
- `notifications`

## API chính

### `GET /api/app-config`
Trả cấu hình app, logo, thông báo, các liên kết hỗ trợ.

### `POST /api/free/create-session`
Body:
```json
{
  "clientId": "..."
}
```
Trả lại short link Link4m hoặc key hiện có nếu thiết bị đã có key miễn phí còn hiệu lực.

### `GET /verify`
Endpoint callback sau khi user vượt link thành công.

### `POST /api/free/claim`
Body:
```json
{
  "rid": "...",
  "clientId": "..."
}
```
Trả key miễn phí sau khi verify thành công.

### `POST /api/key/validate`
Body:
```json
{
  "key": "FREE-XXXX-XXXX-XX",
  "clientId": "..."
}
```
Dùng trong app để kiểm tra key khi login.
