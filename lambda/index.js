import { convertToModelMessages, stepCountIs, streamText, tool } from "ai";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { DsqlSigner } from "@aws-sdk/dsql-signer";
import pg from "pg";
import { z } from "zod";

const bedrock = createAmazonBedrock({
  credentialProvider: fromNodeProviderChain(),
});

const DSQL_ENDPOINT = process.env.DSQL_ENDPOINT;
const AWS_REGION = process.env.AWS_REGION;
const DSQL_DB_ROLE = "app_readonly";

const MODEL_ID =
  process.env.MODEL_ID ?? "minimax.minimax-m2.1";

const SYSTEM_PROMPT = `You are an AI operations copilot for a super-app (rides, delivery, payments) operating in Dubai.
You have access to tools that query the live orders and drivers database.
When a user asks about an operational issue, use your tools to investigate methodically:
1. Query the relevant data (orders, drivers, area stats)
2. Identify patterns and anomalies
3. Synthesize a root cause analysis
4. Propose concrete actions

Always ground your analysis in the data returned by tools. Be concise and actionable.
Format numbers and tables clearly. When referencing areas, use readable names (e.g. "Dubai Marina" not "dubai_marina").
Avoid emojis and decorative symbols. Keep formatting professional and clean.`;

let dbPool = null;
let dbPoolCreatedAt = 0;
const POOL_TTL_MS = 10 * 60 * 1000; // refresh token every 10 min (tokens expire at 15)

async function getPool() {
  if (dbPool && Date.now() - dbPoolCreatedAt < POOL_TTL_MS) return dbPool;

  if (dbPool) {
    await dbPool.end().catch(() => {});
    dbPool = null;
  }

  if (!DSQL_ENDPOINT || !AWS_REGION) {
    throw new Error("DSQL_ENDPOINT and AWS_REGION must be configured.");
  }

  const signer = new DsqlSigner({
    hostname: DSQL_ENDPOINT,
    region: AWS_REGION,
  });
  const token = await signer.getDbConnectAuthToken();

  dbPool = new pg.Pool({
    host: DSQL_ENDPOINT,
    port: 5432,
    user: DSQL_DB_ROLE,
    password: token,
    database: "postgres",
    ssl: { rejectUnauthorized: false },
    max: 2,
  });
  dbPoolCreatedAt = Date.now();
  return dbPool;
}

async function query(sql, params = []) {
  try {
    const pool = await getPool();
    const result = await pool.query(sql, params);
    return result.rows;
  } catch (err) {
    if (err.message?.includes("access denied") || err.message?.includes("authentication")) {
      dbPool?.end().catch(() => {});
      dbPool = null;
      dbPoolCreatedAt = 0;
      const pool = await getPool();
      const result = await pool.query(sql, params);
      return result.rows;
    }
    throw err;
  }
}

const tools = {
  query_orders: tool({
    description:
      "Query recent orders. Can filter by area, status, type, and time range. Returns order details including delays and reasons.",
    inputSchema: z.object({
      area: z
        .string()
        .optional()
        .describe("Filter by area (e.g. dubai_marina, downtown, jbr)"),
      status: z
        .string()
        .optional()
        .describe("Filter by status (pending, assigned, picked_up, delivered, cancelled)"),
      type: z
        .string()
        .optional()
        .describe("Filter by type (delivery, ride, payment)"),
      hours_ago: z
        .number()
        .int()
        .min(1)
        .max(24)
        .optional()
        .default(3)
        .describe("How many hours back to look (default 3, min 1, max 24)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .default(20)
        .describe("Max rows to return (default 20, max 1000)"),
    }),
    execute: async ({ area, status, type, hours_ago, limit }) => {
      const conditions = [
        // `created_at > NOW() - ($1::int * INTERVAL '1 hour')`,
        // For demo purpose, we use the max created_at from the orders table
        `created_at > (SELECT MAX(created_at) FROM orders) - ($1::int * INTERVAL '1 hour')`,
      ];
      const params = [hours_ago];
      let i = 2;

      if (area) {
        conditions.push(`area = $${i++}`);
        params.push(area);
      }
      if (status) {
        conditions.push(`status = $${i++}`);
        params.push(status);
      }
      if (type) {
        conditions.push(`type = $${i++}`);
        params.push(type);
      }

      const sql = `SELECT id, type, status, area, created_at, estimated_delivery_min, actual_delivery_min, delay_reason
        FROM orders WHERE ${conditions.join(" AND ")}
        ORDER BY created_at DESC LIMIT $${i}`;
      params.push(limit);

      return await query(sql, params);
    },
  }),

  get_area_stats: tool({
    description:
      "Get aggregated delivery statistics per area: order count, average delay, cancellation rate, and most common delay reasons. Best for identifying which areas have problems.",
    inputSchema: z.object({
      hours_ago: z
        .number()
        .int()
        .min(1)
        .max(24)
        .optional()
        .default(1)
        .describe("How many hours back to look (default 1, min 1, max 24)"),
    }),
    execute: async ({ hours_ago }) => {
      // We are using "SELECT MAX(created_at) FROM orders"  instead of NOW() in the where clause
      // for demo purpose
      const sql = `
        SELECT
          area,
          COUNT(*) as total_orders,
          ROUND(AVG(CASE WHEN actual_delivery_min IS NOT NULL
            THEN actual_delivery_min - estimated_delivery_min ELSE NULL END), 1) as avg_delay_min,
          ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'cancelled') / COUNT(*), 1) as cancel_rate_pct,
          ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'pending') / COUNT(*), 1) as pending_rate_pct,
          MODE() WITHIN GROUP (ORDER BY delay_reason) FILTER (WHERE delay_reason IS NOT NULL) as top_delay_reason
        FROM orders
        WHERE created_at > (SELECT MAX(created_at) FROM orders) - ($1::int * INTERVAL '1 hour')
        GROUP BY area
        ORDER BY avg_delay_min DESC NULLS LAST`;

      return await query(sql, [hours_ago]);
    },
  }),

  query_drivers: tool({
    description:
      "Query driver availability by area. Shows count of available, busy, and offline drivers.",
    inputSchema: z.object({
      area: z
        .string()
        .optional()
        .describe("Filter by specific area, or omit for all areas"),
    }),
    execute: async ({ area }) => {
      const conditions = [];
      const params = [];

      if (area) {
        conditions.push("area = $1");
        params.push(area);
      }

      const where = conditions.length
        ? `WHERE ${conditions.join(" AND ")}`
        : "";

      const sql = `
        SELECT
          area,
          COUNT(*) as total_drivers,
          COUNT(*) FILTER (WHERE status = 'available') as available,
          COUNT(*) FILTER (WHERE status = 'busy') as busy,
          COUNT(*) FILTER (WHERE status = 'offline') as offline
        FROM drivers
        ${where}
        GROUP BY area
        ORDER BY available ASC`;

      return await query(sql, params);
    },
  }),
};

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { streamifyResponse } from "lambda-stream";

const DATA_STREAM_MODE = (process.env.DATA_STREAM_RESPONSE_MODE ?? "true") === "true";

const WEB_DIR = join(fileURLToPath(import.meta.url), "..", "web");

const MIME_TYPES = {
  ".html": "text/html",
  ".js":   "application/javascript",
  ".css":  "text/css",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".ico":  "image/x-icon",
  ".json": "application/json",
};

function serveStatic(path, responseStream) {
  const safePath = path.replace(/\.\./g, "");
  const filePath = join(WEB_DIR, safePath === "/" || safePath === "" ? "index.html" : safePath);
  const ext = filePath.slice(filePath.lastIndexOf("."));
  const contentType = MIME_TYPES[ext] ?? "application/octet-stream";

  if (!existsSync(filePath)) {
    responseStream.setContentType("text/html");
    responseStream.write("<html><body><p>Not found</p></body></html>");
    responseStream.end();
    return;
  }

  responseStream.setContentType(contentType);
  responseStream.write(readFileSync(filePath));
  responseStream.end();
}

async function toModelMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return [];
  }

  if (Array.isArray(messages[0]?.parts)) {
    return await convertToModelMessages(messages, { tools });
  }

  return messages;
}

async function pipeWebResponseToStream(response, responseStream) {
  const contentType = response.headers.get("content-type");
  if (contentType) {
    responseStream.setContentType(contentType);
  }

  let stream = responseStream;
  const awsLambdaRuntime = globalThis.awslambda;
  if (awsLambdaRuntime?.HttpResponseStream?.from) {
    stream = awsLambdaRuntime.HttpResponseStream.from(responseStream, {
      statusCode: response.status || 200,
      headers: Object.fromEntries(response.headers.entries()),
    });
  }

  if (!response.body) {
    stream.end();
    return;
  }

  const readable = Readable.fromWeb(response.body);
  await new Promise((resolve, reject) => {
    readable.pipe(stream);
    readable.on("end", resolve);
    readable.on("error", reject);
  });
}

export async function createAgentStream(messages) {
  const modelMessages = await toModelMessages(messages);
  return streamText({
    model: bedrock(MODEL_ID),
    system: SYSTEM_PROMPT,
    messages: modelMessages,
    tools,
    stopWhen: stepCountIs(10),
  });
}

export const handler = streamifyResponse(
  async (event, responseStream) => {
    const path = event.requestContext?.http?.path ?? "/";

    if (!path.startsWith("/api/")) {
      serveStatic(path, responseStream);
      return;
    }

    const { messages } = JSON.parse(event.body ?? "{}");

    if (!messages?.length) {
      responseStream.setContentType("application/json");
      responseStream.write(JSON.stringify({ error: "messages required" }));
      responseStream.end();
      return;
    }

    const result = await createAgentStream(messages);

    if (DATA_STREAM_MODE) {
      const response = result.toUIMessageStreamResponse();
      await pipeWebResponseToStream(response, responseStream);
    } else {
      for await (const part of result.fullStream) {
        switch (part.type) {
          case "text-delta":
            responseStream.write(
              JSON.stringify({ type: "text-delta", text: part.textDelta ?? part.text }) + "\n"
            );
            break;
          case "tool-call":
            responseStream.write(
              JSON.stringify({
                type: "tool-call",
                name: part.toolName,
                args: part.args,
              }) + "\n"
            );
            break;
          case "tool-result":
            responseStream.write(
              JSON.stringify({
                type: "tool-result",
                name: part.toolName,
                result: part.result,
              }) + "\n"
            );
            break;
          case "error":
            responseStream.write(
              JSON.stringify({ type: "error", error: String(part.error) }) + "\n"
            );
            break;
        }
      }
      responseStream.end();
    }
  }
);
