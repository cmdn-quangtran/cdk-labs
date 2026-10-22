#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { CdkWebFunctionsStack } from '../lib/cdk-web-functions-stack';

const app = new cdk.App();
// Lambda Web Functions chưa có ở ap-southeast-1, dùng Tokyo
new CdkWebFunctionsStack(app, 'CdkWebFunctionsStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'ap-northeast-1' },
});
