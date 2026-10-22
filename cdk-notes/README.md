# cdk-notes

Lab AWS CDK: REST API ghi chú serverless với API Gateway, Lambda và DynamoDB.

## Kiến trúc

Client gọi API Gateway, API Gateway gọi một Lambda (`lambda/notes.ts`, bundle bằng `NodejsFunction`), Lambda đọc và ghi bảng DynamoDB.

| Method | Path | Mô tả |
| --- | --- | --- |
| POST | `/notes` | Tạo ghi chú |
| GET | `/notes` | Liệt kê ghi chú |
| GET | `/notes/{id}` | Xem một ghi chú |

## Chạy thử

```bash
pnpm install
pnpm test          # test hạ tầng
pnpm cdk diff
pnpm cdk deploy    # in ra ApiUrl
pnpm cdk destroy   # dọn dẹp
```

Stack deploy vào account và region theo cấu hình AWS CLI hiện tại. Bảng DynamoDB đặt `RemovalPolicy.DESTROY`, nên `cdk destroy` xóa cả dữ liệu.
