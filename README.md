# AI Chat Demo App (It's just me learning stuff)

Streaming agentic assistant for investigating super-app operational incidents.

Built with AWS Bedrock models, AWS Lambda (streaming function URL), Aurora DSQL, and CDK. Default model is MiniMax 2.1. Can we switched to any other via environment variable.

## Choice of tech

- AWS is the largest cloud provider
- Serverless saves me $ for a demo app. Serverless compute like GCP Cloud Run is great, but the addition of serverless DB (Aurora DSQL) provision-able via code (CDK) is less friction for self-hosting purpose. It's all in one cloud infra.
- Lambda function URL supports streaming (SSE is needed for LLM responses) and it's cheaper than having an ALB + Fargate setup.
- AI SDK is simple, supports AWS Bedrock, can switch models easily. And returning response back in their `DataStreamResponse` format gives is compatibility with use React hooks like `useChat` or even pre-build UI like [assistant-ui](https://github.com/assistant-ui/assistant-ui).

## Setup

```bash
# Install dependencies
cd infra && npm install # ignore warnings
cd ../scripts && npm install
```

## Deploy

Your `~/.aws/credentials` file needs a `personal` profile:
```ini
[personal]
aws_access_key_id = ...
aws_secret_access_key = ...
```
Optionally add AWS `region` (by default `eu-west-1`) to `~/.aws/config`:
```ini
[profile personal]
region = eu-west-1
```

Then deploy
```bash
cd infra
# one-time setup
npx cdk bootstrap
# Run this on every deployment
npx cdk deploy
```

That outputs the Lambda function URL and DSQL endpoint.

## Seed the database

```bash
cd scripts
AWS_PROFILE=personal AWS_REGION=eu-west-1 DSQL_ENDPOINT=<endpoint-from-deploy-output> npm run seed
```

Populates ~800 orders and ~120 drivers with a baked-in anomaly: Dubai Marina has a driver shortage and delivery delays in the last hour.
