import { createServer } from "node:http";
import {
  CloudFormationClient,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required (set it in .env or shell env).`);
  }
  return value;
}

const AWS_REGION = requireEnv("AWS_REGION");
const STACK_NAME = requireEnv("STACK_NAME");
const PORT = process.env.PORT ?? 3001;
const DATA_STREAM_MODE = (process.env.DATA_STREAM_RESPONSE_MODE ?? "true") === "true";

async function getStackOutput(key) {
  const cfn = new CloudFormationClient({ region: AWS_REGION });
  try {
    const { Stacks } = await cfn.send(new DescribeStacksCommand({ StackName: STACK_NAME }));
    const output = Stacks?.[0]?.Outputs?.find((o) => o.OutputKey === key);
    return output?.OutputValue;
  } catch (error) {
    // Dev should keep running even without stack/credentials.
    console.warn(
      `Stack lookup failed (${error?.name ?? "Error"}): ${error?.message ?? String(error)}`,
    );
    return undefined;
  }
}

async function start() {
  if (!process.env.DSQL_ENDPOINT) {
    const endpoint = await getStackOutput("DsqlEndpoint");
    if (endpoint) {
      process.env.DSQL_ENDPOINT = endpoint;
    } else {
      console.warn(
        `Could not resolve DSQL_ENDPOINT from stack '${STACK_NAME}' in region '${AWS_REGION}' (profile='${process.env.AWS_PROFILE ?? "default"}').`,
      );
      console.warn("Deploy the stack and ensure the correct AWS profile/region/stack are selected.");
    }
  }

  if (!process.env.GUARDRAIL_ID) {
    const guardrailId = await getStackOutput("GuardrailId");
    if (guardrailId) {
      process.env.GUARDRAIL_ID = guardrailId;
    }
  }

  const {
    handler,
    createAgentStream,
    checkGuardrail,
    extractLatestUserText,
    createBlockedResponse,
  } = await import("./index.js");

  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");

  const WEB_DIR = join(import.meta.dirname, "web");
  const MIME_TYPES = {
    ".html": "text/html",
    ".js":   "application/javascript",
    ".css":  "text/css",
    ".svg":  "image/svg+xml",
    ".png":  "image/png",
    ".ico":  "image/x-icon",
    ".json": "application/json",
  };

  const server = createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = req.url ?? "/";

    if (!url.startsWith("/api/")) {
      const safePath = url.replace(/\.\./g, "");
      const filePath = join(WEB_DIR, safePath === "/" ? "index.html" : safePath);
      const ext = filePath.slice(filePath.lastIndexOf("."));
      const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
      try {
        const data = await readFile(filePath);
        res.writeHead(200, { "Content-Type": contentType });
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end("Not found — run `npm run build` from project root");
      }
      return;
    }

    const body = await new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => resolve(data));
    });

    const { messages } = JSON.parse(body);
    if (!messages?.length) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "messages required" }));
      return;
    }

    if (!process.env.DSQL_ENDPOINT) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "DSQL_ENDPOINT not configured",
          hint: `Ensure stack '${STACK_NAME}' exists in region '${AWS_REGION}' for profile '${process.env.AWS_PROFILE ?? "default"}'`,
        }),
      );
      return;
    }

    const userText = extractLatestUserText(messages);
    if (userText) {
      const blocked = await checkGuardrail(userText);
      if (blocked) {
        const { Readable } = await import("node:stream");
        const blockedResponse = createBlockedResponse(blocked);
        res.writeHead(
          blockedResponse.status || 200,
          Object.fromEntries(blockedResponse.headers.entries()),
        );
        if (!blockedResponse.body) {
          res.end();
          return;
        }
        Readable.fromWeb(blockedResponse.body).pipe(res);
        return;
      }
    }

    if (DATA_STREAM_MODE) {
      const result = await createAgentStream(messages);
      result.pipeUIMessageStreamToResponse(res);
    } else {
      const event = {
        body,
        headers: { "content-type": "application/json" },
        requestContext: { http: { method: "POST", path: "/api/chat" } },
      };
      const result = await handler(event);
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.end(result.body ?? result);
    }
  });

  server.listen(PORT, () => {
    console.log(`Dev server: http://localhost:${PORT}`);
    console.log(`AWS: profile=${process.env.AWS_PROFILE ?? "default"} region=${AWS_REGION} stack=${STACK_NAME}`);
    console.log(`Stream mode: ${DATA_STREAM_MODE ? "ui-message-stream" : "ndjson"}`);
    console.log(`Model: ${process.env.MODEL_ID ?? "minimax.minimax-m2.1"}`);
    console.log(`DSQL: ${process.env.DSQL_ENDPOINT ?? "not set"}`);
  });
}

start();
