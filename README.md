# AI Chat Demo App

This app is just me playing with tech, it's not for any serious use.

You can view this app at [ai-chat.codepasta.com](https:/ai-chat.codepasta.com).

Imagine a food delivery company like DoorDash. This chat app's purpose is to help back office managers to diagnose operational issues faster. You can ask question like "List delivery delays by area", "Tell me about current driver capacity / availability".

Built with AWS Bedrock (Minimax 2.1), AWS Lambda (function URL in response streaming mode), Aurora DSQL, and CDK.

## Choice of tech

- AWS is the largest cloud provider
- Serverless saves me $ for a demo app. Serverless compute like GCP Cloud Run is great, but the addition of serverless DB (Aurora DSQL) provision-able via code (CDK) is less friction for self-hosting purpose. It's all in one cloud infra.
- Lambda function URL supports streaming (SSE is needed for LLM responses) and it's cheaper than having an ALB + Fargate setup.
- AI SDK is simple, supports AWS Bedrock, can switch models easily. And returning response back in their `DataStreamResponse` format gives is compatibility with use React hooks like `useChat` or even pre-build UI like [assistant-ui](https://github.com/assistant-ui/assistant-ui).

### Codebase structure
`infra`: AWS CDK code
`lambda`: AWS lambda server
`web`: React, Vite code
`scripts`: Script to add dummy data to database

## Prerequisites

- Node.js 22+
- npm 10+
- AWS credentials configured (`~/.aws/credentials`)

Run shorthand `npm run install-all` for running `npm install` on all sub directories.

## Configure Once

```bash
cp .env.example .env
```

By default, commands assume:

- `AWS_PROFILE=personal`
- `AWS_REGION=eu-west-1`
- `STACK_NAME=ai-chat-stack`
- `NAMESPACE=ai-chat`

You can edit `.env` once and all project scripts will reuse it automatically.

## Local Test (quick path)

You need to run CDK at least once to create DSQL database. Then do:

```bash
npm run seed
npm run dev
```

Then open `http://localhost:3001`.

Notes:

- `npm run dev` runs `vite build --watch` and the local Lambda server together, then serves both API and built frontend from `lambda/dev.js`.
- `npm run seed` creates a read-only DB user (because this can't be done via CDK), attaches IAM to allow lambda to call and populates the DB with dummy data. It auto-resolves `DSQL_ENDPOINT` from CloudFormation stack output (`$STACK_NAME`) if not provided.

## Guardrail Testing (isolated)

Use this when you want to validate guardrail behavior without deploying Lambda changes:

```bash
npm run test:guardrail
```

Custom prompt:

```bash
./scripts/test-guardrail.sh "Dubai Marina delivery delays — what's going on?"
```

## Deploy to AWS

First time in an account/region:
```bash
npm run bootstrap
```

Every deploy:
```bash
npm run deploy
```

CDK outputs:

- `FunctionUrl`
- `DsqlEndpoint`
- `AgentRoleArn`

After deploy, reseed data:

```bash
npm run seed
```

## Security Notes

- LLM tool gets a very limited tool to query database. It does not have direct DB query access.
- Let's say we wanted to build a tool that has full read-access to DB, then you can see that I restricted the Lambda's IAM permissions access to read-only access to DB.
- AWS Bedrock Guardrails (Standard tier) are applied to user input before it reaches the model. The guardrail checks for prompt injection attacks, harmful content, system prompt extraction attempts, and off-topic conversations. This is a cheap pre-model gate (~$0.15/1k text units) that blocks obvious violations without burning a model call. For nuanced/borderline cases that slip past the guardrail, the system prompt instructs the model to stay on-topic.
