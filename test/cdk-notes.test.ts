import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { CdkNotesStack } from '../lib/cdk-notes-stack';

test('creates one on-demand DynamoDB table', () => {
  const stack = new CdkNotesStack(new cdk.App(), 'TestStack');
  const template = Template.fromStack(stack);

  template.resourceCountIs('AWS::DynamoDB::Table', 1);
  template.hasResourceProperties('AWS::DynamoDB::Table', {
    BillingMode: 'PAY_PER_REQUEST',
  });
});
