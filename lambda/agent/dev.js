import { createServer } from "node:http";
import {
  CloudFormationClient,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";

const STACK_NAME = "ai-chat-stack";
const PORT = process.env.PORT ?? 3001;

async function getStackOutput(key) {
  const cfn = new CloudFormationClient({ region: process.env.AWS_REGION ?? "eu-west-1" });
  const { Stacks } = await cfn.send(new DescribeStacksCommand({ StackName: STACK_NAME }));
  const output = Stacks?.[0]?.Outputs?.find((o) => o.OutputKey === key);
  return output?.OutputValue;
}

async function start() {
  if (!process.env.DSQL_ENDPOINT) {
    const endpoint = await getStackOutput("DsqlEndpoint");
    if (endpoint) {
      process.env.DSQL_ENDPOINT = endpoint;
    } else {
      console.warn("Could not resolve DSQL_ENDPOINT from stack outputs");
    }
  }

  const { handler } = await import("./index.js");

  const server = createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405);
      res.end("POST only");
      return;
    }

    const body = await new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => resolve(data));
    });

    const event = {
      body,
      headers: { "content-type": "application/json" },
      requestContext: { http: { method: "POST" } },
    };

    const result = await handler(event);
    res.writeHead(200, { "Content-Type": "application/x-ndjson" });
    res.end(result.body ?? result);
  });

  server.listen(PORT, () => {
    console.log(`Dev server: http://localhost:${PORT}`);
    console.log(`AWS: profile=${process.env.AWS_PROFILE ?? "default"} region=${process.env.AWS_REGION ?? "not set"}`);
    console.log(`Model: ${process.env.MODEL_ID ?? "minimax.minimax-m2.1"}`);
    console.log(`DSQL: ${process.env.DSQL_ENDPOINT ?? "not set"}`);
  });
}

start();
