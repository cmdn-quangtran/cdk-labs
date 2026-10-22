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
