# AWS CDK: Chạy HTTP server Node.js trực tiếp trên Lambda với Lambda Web Functions

Series AWS CDK — Bài 2

Đối tượng: Developer đã hoàn thành Bài 1 (App, Stack, Construct và API ghi chú với API Gateway, Lambda, DynamoDB).

Thời gian thực hành: 45–60 phút.


## Mục tiêu

Sau bài viết này, bạn sẽ:

- Hiểu Lambda Web Functions khác Lambda Event Functions ở điểm nào, và ba form factor của Lambda.
- Phân biệt Web Function, revision và endpoint, và hiểu cách canary, rollback hoạt động với revision weights.
- Biết vì sao Web Functions hiện chỉ có L1 construct và cách dùng chúng.
- Chạy lại API ghi chú dưới dạng một HTTP server Node.js, không cần `handler(event)`.
- Deploy, gọi thử API và kiểm tra log.
- Dọn dẹp tài nguyên sau khi hoàn thành lab.

## 1. Lambda Web Functions là gì?

### 1.1. Vấn đề của Event Functions

Ở Bài 1, code Lambda có dạng `handler(event)`: API Gateway gói HTTP request thành một event JSON, handler xử lý event đó và trả về một object có `statusCode` và `body`. AWS gọi mô hình này là **Lambda Event Functions**. Cách này hoạt động tốt, nhưng nếu bạn đã có sẵn một app Express hay Fastify chạy local, bạn phải viết lại hoặc bọc nó qua một lớp adapter thì mới chạy được trên Lambda.

**Lambda Web Functions** giải quyết việc này. Theo AWS, bạn deploy một web application Node.js (một process lắng nghe trên một port) mà không cần adapter hay framework lock-in. Lambda quản lý execution environments, HTTPS endpoint, scaling và billing.

【Ảnh 1: `01-handler-vs-server.png`】
Hai sơ đồ đặt cạnh nhau. Bên trái, tiêu đề "Event Function (Bài 1)": Client → API Gateway → Lambda `handler(event)` → DynamoDB. Giữa API Gateway và Lambda ghi nhãn nổi bật "request → event JSON". Bên phải, tiêu đề "Web Function (Bài 2)": Client → Endpoint (HTTPS, TLS) → HTTP server Node.js (listen tại `AWS_LAMBDA_HTTP_ENDPOINT`) → DynamoDB. Giữa Endpoint và server ghi nhãn "HTTP thường, không đổi sang event".

### 1.2. Ba Lambda form factor

Khi giới thiệu Web Functions, AWS đặt nó cạnh hai form factor khác của Lambda. Cả ba dùng chung công nghệ cô lập Firecracker, nhưng mỗi loại sinh ra cho một kiểu workload:

- **Event Functions**: mô hình quen thuộc, mỗi execution environment chạy một handler với một request tại một thời điểm (single-concurrent) và billing theo wall-clock time. Phù hợp với queue consumer và xử lý do service khác kích hoạt, như S3 event hay SQS message.
- **Web Functions**: HTTP-native, mỗi execution environment xử lý nhiều request đồng thời (multi-concurrent), billing theo active CPU. Phù hợp với web application và API backend.
- **MicroVMs**: sandbox cô lập, có trạng thái (stateful), vòng đời do khách hàng tự quản lý. Phù hợp với code không tin cậy hoặc do người dùng tạo ra.

Vì sao AWS tách thành ba loại? Vì các workload này cần những thứ khác nhau. Workload hướng sự kiện cần handler đơn giản, mỗi invocation tách biệt. Ứng dụng web cần giữ nguyên mô hình HTTP server và dùng chung một process cho nhiều request để tiết kiệm chi phí khi chờ I/O. Code không tin cậy cần một sandbox cô lập và tự kiểm soát vòng đời. Bài này chỉ dùng Web Functions, hai loại còn lại nhắc ở đây để bạn biết nên chọn loại nào.

Một số đặc điểm của Web Functions:

- **Multi-concurrent**: mỗi execution environment xử lý tối đa 128 request đồng thời, mặc định 64 (giá trị `maxConcurrencyPerEnvironment`).
- **Active CPU billing**: bạn trả tiền cho requests, thời gian CPU mà application và runtime thực sự dùng, memory trong suốt vòng đời của execution environment, và data transfer. Request chỉ chờ database hay API bên ngoài tốn rất ít CPU.
- **Scale to zero**: Lambda xóa các execution environment nhàn rỗi khi không có traffic.
- **Built-in HTTPS endpoint** có TLS. Mỗi endpoint chọn **application-managed authentication** (app tự xác thực, `ApplicationManaged`) hoặc **IAM authentication** (`IamAuth`).
- **Response streaming** không cần cấu hình thêm.
- Có thể đặt CloudFront phía trước endpoint để dùng custom domain hoặc AWS WAF, và dùng origin access control (OAC) để chỉ distribution của bạn gọi được endpoint.
- Có thể deploy nhiều Region sau một endpoint, Lambda định tuyến request theo latency.

Tại thời điểm viết, Web Functions chỉ hỗ trợ **Node.js 24** (`nodejs24.x`). Khi ra mắt, tính năng có ở 5 Region: us-east-1, us-east-2, us-west-2, ap-northeast-1 (Tokyo), eu-west-1. Singapore (ap-southeast-1) chưa có, nên bài này dùng Tokyo. Danh sách Region có thể thay đổi, hãy kiểm tra lại tài liệu AWS trước khi làm lab.

### 1.3. Web Function, revision và endpoint

Theo tài liệu AWS, Web Function có ba loại resource. Trước khi đi vào tên gọi, hãy xem lý do.

**Vấn đề.** Ở Bài 1, mỗi lần `cdk deploy`, CloudFormation cập nhật trực tiếp Lambda function đang chạy. Nếu bản mới có lỗi, muốn quay lại bạn phải sửa code về bản cũ rồi deploy lại, trong lúc đó người dùng vẫn gặp lỗi.

**Ý tưởng.** Thay vì sửa bản đang chạy, ta giữ nguyên bản cũ, tạo bản mới bên cạnh, rồi chỉ đổi việc request đi vào bản nào. Muốn vậy phải tách hai thứ vốn bị gộp chung: phần chứa code và cấu hình đã đóng gói, và phần nhận request từ client.

Nếu bạn từng dùng Lambda Event Functions, ý tưởng này giống *version* (bản chụp bất biến của function) và *alias* (tên trỏ tới version, có thể chia traffic giữa hai version). Bài 1 chưa dùng hai thứ này nên bạn chưa biết cũng không sao. Web Functions có ba resource riêng:

- **Web Function**: top-level resource đại diện cho web application của bạn. Có tên, ARN và trạng thái riêng (`Pending`, `Active`, `Failed`, `Deleting`). Revision và endpoint là child resource, đều thuộc về một Web Function.
- **Revision**: **immutable snapshot** của application code và configuration, gồm vị trí code trên S3, runtime, execution role, environment variables, `timeoutSeconds` và `maxConcurrencyPerEnvironment`. Mỗi lần đổi code hoặc revision configuration, bạn tạo một revision mới, không sửa revision cũ.
- **Endpoint**: network entry point định tuyến HTTP traffic tới revision. Mỗi endpoint có domain name riêng với TLS, authentication type, scaling settings và throttling settings. Một Web Function có thể có nhiều endpoint, mỗi endpoint cấu hình độc lập. Endpoint định tuyến tới một hoặc hai revision theo **revision weights**.

Hình dưới lấy từ ví dụ trong tài liệu AWS: endpoint `prod` gửi 90% traffic tới revision 1 và 10% tới revision 2, endpoint `staging` gửi toàn bộ traffic tới revision 2.

【Ảnh 2: `02-resource-model.png`】
Sơ đồ trong khung "Web Function". Bên trái có hai khối Endpoint: "prod" và "staging" (ghi chú: domain HTTPS có TLS, kiểu xác thực, scale và throttle, cấu hình độc lập). Bên phải có hai khối Revision: "Revision 1" (ghi chú: code từ S3, runtime, execution role, biến môi trường, timeout) và "Revision 2" (ghi chú: đổi code hoặc cấu hình thì tạo revision mới). Mũi tên từ prod tới Revision 1 nhãn 90 và tới Revision 2 nhãn 10. Mũi tên từ staging tới Revision 2 nhãn 100.

Trạng thái của Web Function, revision và endpoint độc lập với nhau. Web Function có thể `Active` trong khi một endpoint vẫn `Pending` hoặc `Failed`, và một revision có thể `Active` dù chưa endpoint nào định tuyến tới nó.

Khi tạo endpoint, bạn chọn **endpoint type**, quyết định phạm vi địa lý:

- `HomeRegion`: phục vụ traffic từ home Region. Đơn giản nhất và là type dùng trong bài này.
- `MultiRegion`: nhiều Region sau một global domain, định tuyến theo network latency (best-effort).
- `PerRegion`: nhiều Region, mỗi Region một domain riêng.

Endpoint type không đổi được sau khi tạo. Với `ApplicationManaged`, Lambda chuyển mọi request vào app và app tự xử lý authentication. Với `IamAuth`, người gọi phải ký request bằng Signature Version 4 (SigV4), hoặc SigV4a với endpoint `MultiRegion`.

### 1.4. Revision weights, canary và rollback

Nhờ tách endpoint khỏi revision, ta quyết định được mỗi revision nhận bao nhiêu phần trăm traffic bằng **revision weights**. Quy tắc theo tài liệu AWS:

- Mỗi weight là số nguyên từ 1 đến 100, tổng các weight phải bằng 100.
- Endpoint định tuyến tới tối đa hai revision cùng lúc.
- Một revision duy nhất phải có weight 100.
- Revision trong danh sách phải ở trạng thái `Active` khi đặt weight.

Nhờ revision là immutable, **rollback** và **canary deployment** trở nên đơn giản. Giả sử revision 1 đang chạy ổn và bạn vừa tạo revision 2:

1. Revision 1 nhận 100% traffic.
2. Chuyển 10% sang revision 2 (weights 90/10), theo dõi lỗi và độ trễ.
3. Nếu revision 2 đạt yêu cầu, chuyển 100% sang revision 2.
4. Nếu revision 2 có lỗi, đặt lại revision 1 là 100%. Không cần sửa hay build lại gì.

Ngoài ra còn **blue-green deployment**: giữ revision hiện tại phục vụ traffic trong lúc kiểm tra revision mới, rồi chuyển toàn bộ traffic trong một lần cập nhật endpoint.

Hai lưu ý từ tài liệu AWS:

- **Web Function metrics không có dimension theo revision**, nên không tách được lỗi của canary khỏi lỗi của revision hiện tại. Hãy ghi một mã build hoặc revision do bạn kiểm soát vào application logs hoặc custom metrics.
- **Revision mới không sao chép configuration từ revision hiện tại.** Mọi setting bạn bỏ sót sẽ lấy giá trị mặc định (ví dụ `timeoutSeconds` là 30 và không có environment variables), nên phải khai báo đầy đủ mỗi lần.

Endpoint còn có **auto-deployment mode** (`autoDeploymentMode`) ở API và CLI:

- `LatestRevision`: mỗi revision mới sau khi `Active` sẽ nhận 100% traffic. Phù hợp với dev và staging. Chỉ hỗ trợ endpoint `HomeRegion`.
- `Disabled` (mặc định): Lambda không đổi traffic routing khi có revision mới, bạn tự đặt `revisionWeights`. Phù hợp với production khi muốn canary hoặc blue-green.

Trong phiên bản CDK của bài này, `CfnWebFunctionEndpoint` **không có** thuộc tính `autoDeploymentMode`, chỉ có `revisionWeights`. Vì vậy ở stack trong Mục 4.4, ta gắn weight 100 vào revision duy nhất. Khi code đổi, CloudFormation tạo revision mới và cập nhật `revisionWeights` trỏ sang revision đó trong cùng lần deploy. Mình không thử canary bằng CDK trong bài này.

【Ảnh 3: `03-canary.png`】
Sơ đồ canary theo ba bước đặt cạnh nhau. Bước 1: Endpoint → v1, nhãn 100. Bước 2: Endpoint có hai mũi tên, tới v1 nhãn 90 và tới v2 nhãn 10, kèm chú thích "theo dõi log, lỗi, độ trễ". Bước 3: Endpoint → v2, nhãn 100. Thêm một mũi tên cong màu đỏ nét đứt từ bước 2 quay về v1 của bước 1, ghi "Rollback nếu v2 lỗi: đặt lại v1 = 100".

### 1.5. Liên hệ với L1, L2, L3 ở Bài 1

Bài 1 có nguyên tắc: ưu tiên L2, chỉ dùng L1 khi L2 chưa hỗ trợ. Web Functions là trường hợp điển hình của vế sau. Hiện chỉ có ba L1 construct trong `aws-cdk-lib/aws-lambda`, chưa có L2:

| CloudFormation | L1 construct |
| --- | --- |
| `AWS::Lambda::WebFunction` | `CfnWebFunction` |
| `AWS::Lambda::WebFunctionRevision` | `CfnWebFunctionRevision` |
| `AWS::Lambda::WebFunctionEndpoint` | `CfnWebFunctionEndpoint` |

Dùng L1 nghĩa là nhiều việc L2 thường làm hộ, ta phải tự khai báo: S3 bucket, bucket policy, IAM role, thứ tự tạo tài nguyên. Phần còn lại của bài là xem cụ thể việc đó như thế nào.

### 1.6. Ràng buộc cần biết trước khi viết code

1. Code chỉ nhận từ **S3** (file zip). Bucket phải **bật versioning** và có bucket policy cho `lambda.amazonaws.com` đọc `s3:GetObject` và `s3:GetObjectVersion`.
2. Entry mặc định là `index.js` ở root của file zip (đổi bằng biến môi trường `AWS_LAMBDA_NODEJS_ENTRYPOINT`).
3. Server phải lắng nghe đúng `host:port` trong biến môi trường `AWS_LAMBDA_HTTP_ENDPOINT`, và bắt đầu lắng nghe trong vòng 10 giây.
4. Lambda **không kiểm tra** server có lắng nghe hay không khi tạo revision, nên revision và endpoint vẫn có thể là `Active` trong khi request bị lỗi. Sau mỗi lần deploy hãy gửi request thử và xem log.
5. Lambda đọc code trực tiếp từ bucket của bạn. Nếu xóa object (hoặc đúng phiên bản object) mà revision đang dùng, hoặc gỡ quyền đọc của Lambda, revision sẽ chuyển sang `Failed` và **không phục hồi được**, chỉ có cách tạo revision mới. Vì vậy hãy giữ lại các phiên bản object của những revision còn dùng hoặc còn cần để rollback.

## 2. Chuẩn bị

Bạn cần hoàn thành Bài 1 (đã có Node.js, pnpm, AWS CLI, credentials). Kiểm tra lại tài khoản:

```bash
aws sts get-caller-identity    # kiểm tra đúng tài khoản
```

Vì Web Functions chạy ở Tokyo, môi trường này cần được bootstrap riêng, giống lưu ý ở Bài 1 về account và region mới. Việc này làm ở Mục 6.1.

## 3. Tạo project

Tạo folder mới **ngang cấp** với `cdk-notes`. Project ở Bài 1 không bị thay đổi.

```bash
cd cdk-series
mkdir cdk-web-functions && cd cdk-web-functions
pnpm dlx aws-cdk init app --language typescript --package-manager pnpm
```

Sau lệnh này bạn có `bin/cdk-web-functions.ts`, `lib/cdk-web-functions-stack.ts`, `cdk.json`, thư mục `test/` và các dependencies đã được cài.

【Ảnh 4: `04-cdk-init.png`】
Ảnh chụp terminal sau khi `cdk init` chạy xong, hiện dòng "All done!" và cây thư mục project gồm `bin`, `lib`, `test`, `cdk.json`, `package.json`. Bên cạnh là thư mục `cdk-notes` để thấy hai project nằm cùng cấp.

## 4. Thực hành: API ghi chú dưới dạng HTTP server

API vẫn là hai endpoint của Bài 1: `POST /notes` tạo ghi chú và `GET /notes` liệt kê. Mình thêm `GET /slow` (chờ 1 giây) để thử nhanh server ở local.

【Ảnh 5: `05-architecture.png`】
Sơ đồ kiến trúc từ trái sang phải: Client (curl) → Endpoint (HomeRegion, ApplicationManaged) → HTTP server Node.js (nodejs24.x) nằm trong khung "Revision" → DynamoDB (NotesTable). Bên dưới vẽ S3 bucket (versioning bật, chứa file zip code) với mũi tên đứt nét lên Revision ghi "Lambda đọc code". Bên trái S3 có khối "cdk deploy" (BucketDeployment upload zip) với mũi tên đứt nét tới S3. Bên phải có khối "Execution role" (ghi CloudWatch Logs, đọc/ghi DynamoDB) với mũi tên đứt nét tới DynamoDB ghi "cấp quyền".

### 4.1. Cài thêm dependency

Giống Bài 1, ta dùng esbuild để bundle TypeScript thành một file JavaScript. Khác với `NodejsFunction`, Web Function không tự bundle giúp ta, nên bước build là việc của mình.

```bash
pnpm add @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb
pnpm add -D esbuild
```

### 4.2. Code ứng dụng

Tạo file `web-app/index.ts`. So với `lambda/notes.ts` ở Bài 1, không còn `APIGatewayProxyEvent` hay `event.httpMethod`, mà là `req.method` và `req.url` của `node:http`. Điểm khác duy nhất so với một app Node.js thông thường là đọc `AWS_LAMBDA_HTTP_ENDPOINT` để biết cần lắng nghe ở đâu. Nếu bạn dùng Express, Hono hay Fastify thì cũng chỉ đổi đúng chỗ này.

```ts
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const TABLE_NAME = process.env.TABLE_NAME!;
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const server = createServer(async (req, res) => {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  try {
    if (req.method === 'GET' && req.url === '/notes') {
      const { Items = [] } = await db.send(new ScanCommand({ TableName: TABLE_NAME }));
      return send(200, Items);
    }
    if (req.method === 'POST' && req.url === '/notes') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const { title, content = '' } = JSON.parse(raw || '{}');
      if (!title) return send(400, { message: 'title is required' });
      const note = { id: randomUUID(), title, content, createdAt: new Date().toISOString() };
      await db.send(new PutCommand({ TableName: TABLE_NAME, Item: note }));
      return send(201, note);
    }
    // Giả lập I/O chờ 1 giây
    if (req.method === 'GET' && req.url === '/slow') {
      await new Promise((r) => setTimeout(r, 1000));
      return send(200, { at: new Date().toISOString() });
    }
    send(404, { message: 'not found' });
  } catch (err) {
    console.error(err);
    send(500, { message: 'internal error' });
  }
});

// Lambda cho biết host:port cần lắng nghe qua AWS_LAMBDA_HTTP_ENDPOINT
const [host, port] = (process.env.AWS_LAMBDA_HTTP_ENDPOINT || '127.0.0.1:3000').split(':');
server.listen(Number(port), host, () => console.log(`listening on ${host}:${port}`));
process.on('SIGTERM', () => server.close());
```

Một ưu điểm nhỏ: bạn chạy thử local được ngay, không cần emulator.

```bash
TABLE_NAME=x pnpm tsx web-app/index.ts
curl localhost:3000/slow
```

Route `/notes` cần DynamoDB thật nên chỉ `/slow` chạy được ở local.

### 4.3. Thêm script build

Trong `package.json`, thêm vào mục `scripts`:

```json
"build:web": "esbuild web-app/index.ts --bundle --platform=node --target=node24 --outfile=dist/web-app/index.js"
```

Thêm `dist` vào `.gitignore` rồi chạy build:

```bash
echo dist >> .gitignore
pnpm build:web
```

Kết quả là `dist/web-app/index.js`, file này sẽ nằm ở root của file zip.

### 4.4. Định nghĩa hạ tầng bằng CDK

Thay nội dung `lib/cdk-web-functions-stack.ts`:

```ts
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';

const FUNCTION_NAME = 'cdk-web-functions-demo';

export class CdkWebFunctionsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const table = new dynamodb.Table(this, 'NotesTable', {
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // Chỉ dùng cho lab
    });

    // Web Function chỉ nhận code từ S3, bucket bắt buộc bật versioning
    const codeBucket = new s3.Bucket(this, 'CodeBucket', {
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    codeBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal('lambda.amazonaws.com')],
        actions: ['s3:GetObject', 's3:GetObjectVersion'],
        resources: [codeBucket.arnForObjects('*')],
        conditions: {
          ArnLike: {
            'aws:SourceArn': `arn:aws:lambda:${this.region}:${this.account}:web-function/${FUNCTION_NAME}/revision/*`,
          },
        },
      }),
    );

    // extract: false -> upload nguyên file zip, key đổi theo hash của code
    const code = new s3deploy.BucketDeployment(this, 'DeployCode', {
      sources: [s3deploy.Source.asset('dist/web-app')],
      destinationBucket: codeBucket,
      extract: false,
    });

    const role = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [`arn:aws:logs:*:${this.account}:log-group:/aws/lambda/web/${FUNCTION_NAME}.local:*`],
      }),
    );
    table.grantReadWriteData(role);

    const webFunction = new lambda.CfnWebFunction(this, 'WebFunction', {
      functionName: FUNCTION_NAME,
    });

    const revision = new lambda.CfnWebFunctionRevision(this, 'Revision', {
      functionName: webFunction.functionName,
      buildConfig: {
        codeConfig: { s3Object: { bucket: codeBucket.bucketName, key: cdk.Fn.select(0, code.objectKeys) } },
        runtimeConfig: { runtime: 'nodejs24.x' },
      },
      serviceConfig: {
        executionRoleArn: role.roleArn,
        timeoutSeconds: 30,
        environmentVariables: { TABLE_NAME: table.tableName },
      },
    });
    // functionName là chuỗi thuần nên phải khai báo thứ tự tạo tường minh
    revision.addResourceDependency(webFunction);
    revision.node.addDependency(codeBucket.policy!, role);

    const endpoint = new lambda.CfnWebFunctionEndpoint(this, 'Endpoint', {
      functionName: webFunction.functionName,
      endpointName: 'prod',
      endpointType: 'HomeRegion',
      authType: 'ApplicationManaged',
      revisionWeights: [{ revisionId: revision.attrRevisionId, weight: 100 }],
      scalingConfig: { maxEnvironments: 2 }, // Chặn chi phí cho lab
      throttleConfig: { rateLimit: 100 },
    });

    new cdk.CfnOutput(this, 'EndpointUrl', { value: `https://${endpoint.attrDomainName}` });
  }
}
```

Các điểm cần lưu ý, so sánh với stack ở Bài 1:

- **Không còn `grantReadWriteData(notesFunction)`**: L1 của function không có `grant*`. Tuy nhiên `table.grantReadWriteData(role)` vẫn dùng được, vì ta cấp quyền cho IAM role, và role là L2.
- **`BucketDeployment` với `extract: false`**: giữ nguyên file zip, tên object đổi theo hash của code. Tên object nằm trong `Revision`, nên đổi code sẽ làm CloudFormation tạo revision mới (revision là bất biến).
- **Bucket riêng thay vì bucket bootstrap**: bucket bootstrap không có policy cho Lambda service principal, và bucket của ta cần bật versioning.
- **`aws:SourceArn` trong bucket policy** giới hạn việc đọc code theo đúng function và mọi revision của nó.
- **Quyền ghi log**: ngoài managed policy `AWSLambdaBasicExecutionRole`, doc yêu cầu thêm quyền ghi vào log group `/aws/lambda/web/<tên>.local`.
- **`revision.addResourceDependency(webFunction)`**: `functionName` là chuỗi thuần nên CloudFormation không tự suy ra thứ tự tạo. Ở Bài 1, `table.tableName` là token nên CDK tự suy ra thứ tự. Ở đây ta phải khai báo tay.
- **`revisionWeights` bằng 100 và không có `autoDeploymentMode`**: ta chỉ có một revision nên mọi traffic đi vào đó. Xem lại Mục 1.4 về lý do.
- **`maxEnvironments: 2` và `rateLimit: 100`**: chặn chi phí và tải cho lab.

【Ảnh 6: `06-stack-resources.png`】
Ảnh chụp console CloudFormation của stack `CdkWebFunctionsStack` ở tab Resources sau khi deploy, thấy đủ các resource: DynamoDB table, S3 bucket, IAM role, cùng ba resource `AWS::Lambda::WebFunction`, `AWS::Lambda::WebFunctionRevision` và `AWS::Lambda::WebFunctionEndpoint`.

### 4.5. Chọn region và xử lý lỗi validate

Sửa `bin/cdk-web-functions.ts` để cố định region Tokyo:

```ts
#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { CdkWebFunctionsStack } from '../lib/cdk-web-functions-stack';

const app = new cdk.App();
// Lambda Web Functions chưa có ở ap-southeast-1, dùng Tokyo
new CdkWebFunctionsStack(app, 'CdkWebFunctionsStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'ap-northeast-1' },
});
```

Chạy `pnpm cdk synth` lúc này sẽ lỗi:

```
ERROR Unknown resource type 'AWS::Lambda::WebFunction' (CloudFormation Validate)
Synthesis finished with errors
```

Nguyên nhân là bộ validate mặc định của CDK chưa biết resource type mới. Template vẫn được sinh đúng, nhưng lỗi làm lệnh synth thất bại. Trong `cdk.json`, mục `context`, đổi cờ sau từ `true` sang `false` để lỗi trở thành cảnh báo:

```json
"@aws-cdk/core:validateAgainstDefaultRules": false
```

Cờ này tắt kiểm tra theo rule mặc định cho cả project, nên chỉ nên làm vậy trong lab. Khi CDK cập nhật schema thì bật lại.

## 5. Viết test cho hạ tầng

Như Bài 1, ta kiểm tra hạ tầng bằng test trước khi deploy. Thay nội dung `test/cdk-web-functions.test.ts`:

```ts
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { CdkWebFunctionsStack } from '../lib/cdk-web-functions-stack';

const template = Template.fromStack(
  new CdkWebFunctionsStack(new cdk.App(), 'TestStack', {
    env: { account: '111122223333', region: 'ap-northeast-1' },
  }),
);

test('creates a Web Function with one revision and one endpoint', () => {
  template.resourceCountIs('AWS::Lambda::WebFunction', 1);
  template.resourceCountIs('AWS::Lambda::WebFunctionRevision', 1);
  template.resourceCountIs('AWS::Lambda::WebFunctionEndpoint', 1);
});

test('revision uses Node.js 24', () => {
  template.hasResourceProperties('AWS::Lambda::WebFunctionRevision', {
    BuildConfig: { RuntimeConfig: { Runtime: 'nodejs24.x' } },
  });
});

test('code bucket is versioned', () => {
  template.hasResourceProperties('AWS::S3::Bucket', {
    VersioningConfiguration: { Status: 'Enabled' },
  });
});

test('endpoint caps scaling and request rate', () => {
  template.hasResourceProperties('AWS::Lambda::WebFunctionEndpoint', {
    ScalingConfig: { MaxEnvironments: 2 },
    ThrottleConfig: { RateLimit: 100 },
  });
});
```

Chạy test. Vì stack dùng `Source.asset('dist/web-app')`, bạn cần build app trước, nếu không CDK báo `Cannot find asset`.

```bash
pnpm build:web
pnpm test
```

Kết quả khi mình chạy:

```
Tests:       4 passed, 4 total
```

Test này bắt được các lỗi cấu hình quan trọng của Web Functions, ví dụ quên bật versioning cho bucket.

## 6. Deploy và kiểm chứng

### 6.1. Bootstrap và deploy

Bootstrap Tokyo một lần, rồi `diff` và `deploy` như Bài 1:

```bash
pnpm cdk bootstrap aws://<account-id>/ap-northeast-1
pnpm build:web
pnpm cdk diff
pnpm cdk deploy
```

Lần deploy đầu mất khoảng 106 giây (CDK báo "Deployment time" 78 giây). Khi xong, terminal hiển thị `EndpointUrl`.

【Ảnh 7: `07-deploy-output.png`】
Ảnh chụp terminal cuối lệnh `cdk deploy`, thấy phần "Outputs" với `CdkWebFunctionsStack.EndpointUrl = https://xxxx.lambda-web.ap-northeast-1.on.aws`. Che bớt account ID trong Stack ARN.

Revision và endpoint tự chuyển sang `Active`. Kiểm tra bằng AWS CLI:

```bash
aws lambda-web get-web-function-endpoint \
  --function-name cdk-web-functions-demo --endpoint-name prod \
  --region ap-northeast-1 --query '{state:state,update:updateStatus}'
```

```json
{ "state": "Active", "update": null }
```

### 6.2. Gọi API

```bash
ENDPOINT="<dán EndpointUrl vào đây>"

curl -i -X POST "$ENDPOINT/notes" -H "Content-Type: application/json" \
  -d '{"title":"hello","content":"web functions"}'

curl -i "$ENDPOINT/notes"
```

Kết quả thật (rút gọn header):

```
HTTP/1.1 201 Created
lambda-web-logstream: 2026/10/21/cdk-web-functions-demo[rev-fkpu2]aa9d9c9c216a455f8574abf941776181
lambda-web-request-id: NA74XQCDBQQVBAHXXO7BSQLOX4

{"id":"cdfa354e-79d4-4526-b956-6c1c544fe612","title":"hello","content":"web functions","createdAt":"2026-10-21T07:24:55.810Z"}
```

```
HTTP/1.1 200 OK
[{"content":"web functions","createdAt":"2026-10-21T07:24:55.810Z","id":"cdfa354e-79d4-4526-b956-6c1c544fe612","title":"hello"}]
```

Lambda tự thêm hai header vào response: `lambda-web-request-id` để đối chiếu với log, và `lambda-web-logstream` chứa ID của execution environment đã xử lý request.

### 6.3. Kiểm tra log và đừng chỉ tin trạng thái Active

Trạng thái `Active` của revision, của endpoint hay của lần update **không đảm bảo** server bên trong đang chạy. Ví dụ nếu code gọi `server.listen(3000)` thay vì dùng `AWS_LAMBDA_HTTP_ENDPOINT`, deploy vẫn thành công nhưng request lỗi. Vì vậy sau mỗi lần deploy, hãy gửi một request thật rồi xem log.

Output của `console.log`, `console.info` và `console.error` được gửi tới CloudWatch Logs. Log group có dạng `/aws/lambda/web/<tên function>`, và có thêm log group `.local` để ghi log tại region đang xử lý request. Execution role cần quyền ghi vào cả hai, đó là lý do stack ở Mục 4.4 có thêm một policy cho log group `.local`.

Khi debug, hãy đi lần lượt từ endpoint, tới revision, rồi tới log của app.

## 7. Dọn dẹp

Sau khi thực hành xong, xóa stack:

```bash
pnpm cdk destroy
```

Xác nhận thao tác khi được yêu cầu. Giống Bài 1, `RemovalPolicy.DESTROY` làm DynamoDB table bị xóa cùng dữ liệu, và S3 bucket chứa code cũng bị xóa (nhờ `autoDeleteObjects`). Chỉ chạy khi chắc chắn không cần giữ dữ liệu.

Môi trường bootstrap ở Tokyo vẫn tồn tại sau khi destroy. Project `cdk-notes` ở Bài 1 nằm ở region khác và không bị ảnh hưởng.

## 8. Tổng kết

Sau bài này, chúng ta đã:

- Hiểu Lambda Web Functions chạy HTTP server thay vì `handler(event)`, và mối quan hệ Web Function, Revision, Endpoint.
- Hiểu revision bất biến giúp canary và rollback đơn giản thế nào, và vai trò của `revisionWeights`.
- Thấy một trường hợp cụ thể dùng L1 construct khi L2 chưa có, và cách bù lại phần L2 thường làm hộ (bucket, policy, role, thứ tự tạo).
- Đưa API ghi chú của Bài 1 sang dạng HTTP server mà không cần adapter.
- Viết test hạ tầng, deploy, gọi thử API, kiểm tra log và dọn dẹp.

### Khi nào dùng Web Functions, khi nào dùng Event Functions?

- **Web Functions** hợp với ứng dụng vốn đã là HTTP server (Express, Fastify, Hono, Node.js HTTP, server-side rendering), nơi bạn muốn giữ `req`, `res`, middleware và routing quen thuộc.
- **Event Functions** vẫn là lựa chọn tự nhiên cho xử lý theo sự kiện như S3 event, tin nhắn SQS hay EventBridge.

Web Functions không thay thế mọi trường hợp dùng Lambda. Hãy bắt đầu từ loại workload: ứng dụng HTTP thì xem xét Web Function, xử lý sự kiện thì dùng Event Function.

### Những điểm cần nhớ

1. App phải lắng nghe đúng `host:port` trong `AWS_LAMBDA_HTTP_ENDPOINT`, không có `handler(event)`.
2. Code là file zip trên S3, bucket bật versioning, và Lambda cần quyền đọc object.
3. Revision là bất biến: đổi code hoặc cấu hình thì tạo revision mới.
4. Endpoint là network entry point có HTTPS, định tuyến tới tối đa hai revision theo `revisionWeights` (tổng bằng 100).
5. `ApplicationManaged` nghĩa là app tự xác thực, `IamAuth` dùng chữ ký SigV4.
6. `Active` không có nghĩa là app chạy tốt, hãy gửi request thật và xem log.
7. Giữ lại các phiên bản object S3 mà revision còn dùng hoặc cần để rollback.

Các giới hạn hiện tại: chỉ có Node.js 24, số region còn ít, và chỉ có L1 construct. Những phần mình chưa thử trong bài này: `IamAuth`, canary bằng CDK, CloudFront với OAC, VPC và deploy nhiều region.

## Tài liệu tham khảo

- [Announcing AWS Lambda Web Functions](https://aws.amazon.com/blogs/aws/announcing-aws-lambda-web-functions-for-fast-consistent-web-app-performance-anywhere/)
- [AWS Lambda Web Functions - Developer Guide](https://docs.aws.amazon.com/lambda/latest/dg/web-functions.html)
- [Core concepts](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-how-it-works.html)
- [Deployment patterns](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-deployment.html)
- [Deploying Web Function code from Amazon S3](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-code-s3.html)
- [AWS CDK API Reference: CfnWebFunction](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_lambda.CfnWebFunction.html)
