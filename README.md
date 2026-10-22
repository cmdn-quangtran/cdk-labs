# cdk-labs

Các bài lab luyện tập AWS CDK (TypeScript, pnpm). Mỗi folder là một project CDK độc lập.

| Project | Nội dung |
| --- | --- |
| [cdk-notes](cdk-notes) | REST API ghi chú với API Gateway, Lambda và DynamoDB |
| [cdk-web-functions](cdk-web-functions) | API ghi chú chạy dưới dạng HTTP server trên Lambda Web Functions (region `ap-northeast-1`) |

Chạy một project:

```bash
cd <project>
pnpm install
pnpm cdk deploy
pnpm cdk destroy   # dọn dẹp sau khi thực hành
```

Đây là code để học, không dùng cho production. Các tài nguyên đặt `RemovalPolicy.DESTROY`, nên `cdk destroy` sẽ xóa cả dữ liệu.
