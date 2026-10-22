# cdk-web-functions

Lab AWS CDK: chạy API ghi chú dưới dạng HTTP server Node.js trên Lambda Web Functions, không cần `handler(event)`.

## Kiến trúc

Client gọi endpoint HTTPS của Web Function, endpoint chuyển request tới revision đang chạy HTTP server Node.js (`web-app/index.ts`), server đọc và ghi bảng DynamoDB. Code được đóng gói thành file zip trên S3 bucket có versioning.

Stack dùng ba L1 construct: `CfnWebFunction`, `CfnWebFunctionRevision` và `CfnWebFunctionEndpoint`. Region cố định là `ap-northeast-1` (Tokyo).

| Method | Path | Mô tả |
| --- | --- | --- |
| POST | `/notes` | Tạo ghi chú |
| GET | `/notes` | Liệt kê ghi chú |
| GET | `/slow` | Chờ 1 giây, dùng để thử server |

## Chạy thử

```bash
pnpm install
pnpm cdk bootstrap aws://<account-id>/ap-northeast-1   # lần đầu
pnpm build:web     # bundle app thành dist/web-app/index.js
pnpm test
pnpm cdk deploy    # in ra EndpointUrl
pnpm cdk destroy   # dọn dẹp
```

Cần `pnpm build:web` trước khi chạy test hoặc deploy, vì stack đọc code từ `dist/web-app`. Lỗi `Unknown resource type 'AWS::Lambda::WebFunction'` khi synth đã được xử lý bằng cờ `@aws-cdk/core:validateAgainstDefaultRules` trong `cdk.json`. Bảng DynamoDB và S3 bucket đặt `RemovalPolicy.DESTROY`, nên `cdk destroy` xóa cả dữ liệu.

Bản nháp bài blog nằm ở [blog/lambda-web-functions.md](blog/lambda-web-functions.md).
