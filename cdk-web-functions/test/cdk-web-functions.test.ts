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
