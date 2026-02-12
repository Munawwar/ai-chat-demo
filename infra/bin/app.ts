import * as cdk from "aws-cdk-lib";
import { AiChatStack } from "../lib/stack.ts";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required (set it in .env or shell env).`);
  }
  return value;
}

const STACK_NAME = requireEnv("STACK_NAME");
const NAMESPACE = process.env.NAMESPACE ?? STACK_NAME.replace(/-stack$/, "");

const app = new cdk.App();

new AiChatStack(app, STACK_NAME, {
  namespace: NAMESPACE,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION,
  },
});
