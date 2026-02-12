import { streamText, tool } from "ai";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { DsqlSigner } from "@aws-sdk/dsql-signer";
import pg from "pg";
import { z } from "zod";

const bedrock = createAmazonBedrock({
  credentialProvider: fromNodeProviderChain(),
});

const { DSQL_ENDPOINT, DSQL_REGION = "eu-west-1" } = process.env;

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
Format numbers and tables clearly. When referencing areas, use readable names (e.g. "Dubai Marina" not "dubai_marina").`;

let dbPool = null;

async function getPool() {
  if (dbPool) return dbPool;

  const signer = new DsqlSigner({
    hostname: DSQL_ENDPOINT,
    region: DSQL_REGION,
  });
  const token = await signer.getDbConnectAdminAuthToken();

  dbPool = new pg.Pool({
    host: DSQL_ENDPOINT,
    port: 5432,
    user: "admin",
    password: token,
    database: "postgres",
    ssl: { rejectUnauthorized: false },
    max: 2,
  });
  return dbPool;
}

async function query(sql, params = []) {
  const pool = await getPool();
  const result = await pool.query(sql, params);
  return result.rows;
}

const tools = {
  query_orders: tool({
    description:
      "Query recent orders. Can filter by area, status, type, and time range. Returns order details including delays and reasons.",
    parameters: z.object({
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
        .optional()
        .default(3)
        .describe("How many hours back to look (default 3)"),
      limit: z
        .number()
        .optional()
        .default(20)
        .describe("Max rows to return (default 20)"),
    }),
    execute: async ({ area, status, type, hours_ago, limit }) => {
      const conditions = [
        `created_at > NOW() - INTERVAL '${hours_ago} hours'`,
      ];
      const params = [];
      let i = 1;

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
    parameters: z.object({
      hours_ago: z
        .number()
        .optional()
        .default(1)
        .describe("How many hours back to look (default 1)"),
    }),
    execute: async ({ hours_ago }) => {
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
        WHERE created_at > NOW() - INTERVAL '${hours_ago} hours'
        GROUP BY area
        ORDER BY avg_delay_min DESC NULLS LAST`;

      return await query(sql);
    },
  }),

  query_drivers: tool({
    description:
      "Query driver availability by area. Shows count of available, busy, and offline drivers.",
    parameters: z.object({
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

import { Readable } from "node:stream";
import { streamifyResponse } from "lambda-stream";

const DATA_STREAM_MODE = (process.env.DATA_STREAM_RESPONSE_MODE ?? "true") === "true";

export function createAgentStream(messages) {
  return streamText({
    model: bedrock(MODEL_ID),
    system: SYSTEM_PROMPT,
    messages,
    tools,
    maxSteps: 10,
  });
}

export const handler = streamifyResponse(
  async (event, responseStream) => {
    const { messages } = JSON.parse(event.body ?? "{}");

    if (!messages?.length) {
      responseStream.write(JSON.stringify({ error: "messages required" }));
      responseStream.end();
      return;
    }

    const result = streamText({
      model: bedrock(MODEL_ID),
      system: SYSTEM_PROMPT,
      messages,
      tools,
      maxSteps: 10,
    });

    if (DATA_STREAM_MODE) {
      const readable = Readable.fromWeb(result.toDataStream());
      await new Promise((resolve, reject) => {
        readable.pipe(responseStream);
        readable.on("end", resolve);
        readable.on("error", reject);
      });
    } else {
      for await (const part of result.fullStream) {
        switch (part.type) {
          case "text-delta":
            responseStream.write(
              JSON.stringify({ type: "text-delta", text: part.textDelta }) + "\n"
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
