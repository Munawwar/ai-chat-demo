import * as cdk from "aws-cdk-lib";
import { AiChatStack } from "../lib/stack.ts";

const NAMESPACE = "ai-chat";

const app = new cdk.App();

new AiChatStack(app, `${NAMESPACE}-stack`, {
  namespace: NAMESPACE,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "eu-west-1",
  },
});
