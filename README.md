# AI Chat Demo App

Streaming ops copilot for investigating super-app incidents.

Built with AWS Bedrock, AWS Lambda (response streaming), Aurora DSQL, and CDK.

## Choice of tech

- AWS is the largest cloud provider
- Serverless saves me $ for a demo app. Serverless compute like GCP Cloud Run is great, but the addition of serverless DB (Aurora DSQL) provision-able via code (CDK) is less friction for self-hosting purpose. It's all in one cloud infra.
- Lambda function URL supports streaming (SSE is needed for LLM responses) and it's cheaper than having an ALB + Fargate setup.
- AI SDK is simple, supports AWS Bedrock, can switch models easily. And returning response back in their `DataStreamResponse` format gives is compatibility with use React hooks like `useChat` or even pre-build UI like [assistant-ui](https://github.com/assistant-ui/assistant-ui).

## Prerequisites

- Node.js 22+
- npm 10+
- AWS credentials configured (`~/.aws/credentials`)

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
Do not add `DSQL_ENDPOINT` to `.env`; it is resolved dynamically for local workflows, and injected by CDK for deployed Lambda.

## Install (one command)

```bash
npm run install-all
```

This installs dependencies for:

- `lambda`
- `web`
- `infra`
- `scripts`

## Local Test (quick path)

If you already deployed once before, these are enough:

```bash
npm run seed
npm run dev
```

Then open `http://localhost:3001`.

Notes:

- `npm run dev` runs `vite build --watch` and the local Lambda server together, then serves both API and built frontend from `lambda/dev.js`.
- `npm run seed` auto-resolves `DSQL_ENDPOINT` from CloudFormation stack output (`$STACK_NAME`) if not provided.

## Deploy (quick path)

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

After deploy, reseed data:

```bash
npm run seed
```

## Useful Commands

```bash
npm run build      # build web to lambda/web
npm run dev        # run local lambda dev server on :3001
npm run seed       # seed DSQL data
npm run synth      # cdk synth
npm run deploy     # cdk deploy
```
