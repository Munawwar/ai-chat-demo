# AI Ops Copilot

Streaming agentic assistant for investigating super-app operational incidents. Built with AWS Lambda (streaming function URL), Aurora DSQL, and CDK.

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
npx cdk deploy
```

That outputs the Lambda function URL and DSQL endpoint.

## Seed the database

```bash
cd scripts
DSQL_ENDPOINT=<endpoint-from-deploy-output> npm run seed
```

Populates ~800 orders and ~120 drivers with a baked-in anomaly: Dubai Marina has a driver shortage and delivery delays in the last hour.
