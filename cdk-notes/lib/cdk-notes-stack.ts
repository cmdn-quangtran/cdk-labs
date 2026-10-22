import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';

export class CdkNotesStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const table = new dynamodb.Table(this, 'NotesTable', {
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // Chỉ dùng cho lab
    });

    const notesFunction = new nodejs.NodejsFunction(this, 'NotesFunction', {
      entry: 'lambda/notes.ts',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(10),
      environment: { TABLE_NAME: table.tableName },
    });
    table.grantReadWriteData(notesFunction);

    const api = new apigateway.LambdaRestApi(this, 'NotesApi', {
      handler: notesFunction,
      proxy: false,
    });

    const notes = api.root.addResource('notes');
    notes.addMethod('GET');
    notes.addMethod('POST');
    notes.addResource('{id}').addMethod('GET');

    new cdk.CfnOutput(this, 'ApiUrl', { value: api.url });
  }
}
