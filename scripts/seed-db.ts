import pg from "pg";
import { DsqlSigner } from "@aws-sdk/dsql-signer";
import {
  CloudFormationClient,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required (set it in .env or shell env).`);
  }
  return value;
}

const REGION = requireEnv("AWS_REGION");
const STACK_NAME = requireEnv("STACK_NAME");

async function getStackOutput(key: string): Promise<string | undefined> {
  const cfn = new CloudFormationClient({ region: REGION });
  const { Stacks } = await cfn.send(new DescribeStacksCommand({ StackName: STACK_NAME }));
  return Stacks?.[0]?.Outputs?.find((o: { OutputKey?: string }) => o.OutputKey === key)?.OutputValue;
}

let DSQL_ENDPOINT = process.env.DSQL_ENDPOINT;
if (!DSQL_ENDPOINT) {
  console.log("DSQL_ENDPOINT not set, resolving from CloudFormation...");
  DSQL_ENDPOINT = await getStackOutput("DsqlEndpoint");
}
if (!DSQL_ENDPOINT) {
  console.error("Could not resolve DSQL_ENDPOINT");
  process.exit(1);
}

const AREAS = [
  "dubai_marina",
  "downtown",
  "jbr",
  "deira",
  "business_bay",
  "al_barsha",
  "jumeirah",
  "silicon_oasis",
] as const;

const ORDER_TYPES = ["delivery", "ride", "payment"] as const;
const STATUSES = ["pending", "assigned", "picked_up", "delivered", "cancelled"] as const;
const DELAY_REASONS = ["weather", "no_driver", "traffic", "merchant_slow"] as const;
const DRIVER_STATUSES = ["available", "busy", "offline"] as const;

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pickRandom<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function weightedPick<T>(items: readonly T[], weights: number[]): T {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i]!;
    if (r <= 0) return items[i]!;
  }
  return items[items.length - 1]!;
}

const SCHEMA_STATEMENTS = [
  `DROP TABLE IF EXISTS orders`,
  `DROP TABLE IF EXISTS drivers`,
  `CREATE TABLE orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type VARCHAR(20) NOT NULL,
    status VARCHAR(20) NOT NULL,
    area VARCHAR(50) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    estimated_delivery_min INT NOT NULL,
    actual_delivery_min INT,
    driver_id UUID,
    delay_reason VARCHAR(100)
  )`,
  `CREATE TABLE drivers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    area VARCHAR(50) NOT NULL,
    status VARCHAR(20) NOT NULL,
    last_seen TIMESTAMPTZ NOT NULL
  )`,
  `CREATE INDEX ASYNC idx_orders_area ON orders(area)`,
  `CREATE INDEX ASYNC idx_orders_created_at ON orders(created_at)`,
  `CREATE INDEX ASYNC idx_drivers_area ON drivers(area)`,
];

interface Order {
  type: string;
  status: string;
  area: string;
  created_at: Date;
  estimated_delivery_min: number;
  actual_delivery_min: number | null;
  driver_id: string | null;
  delay_reason: string | null;
}

interface Driver {
  name: string;
  area: string;
  status: string;
  last_seen: Date;
}

function generateDrivers(): Driver[] {
  const firstNames = [
    "Ahmed", "Mohammed", "Ali", "Omar", "Hassan",
    "Khalid", "Saeed", "Youssef", "Tariq", "Rashid",
    "Faisal", "Nasser", "Ibrahim", "Jamal", "Karim",
  ];
  const lastNames = [
    "Al Maktoum", "Khan", "Singh", "Patel", "Rahman",
    "Hassan", "Ali", "Mahmoud", "Hussain", "Sharma",
  ];

  const drivers: Driver[] = [];
  const now = Date.now();

  for (const area of AREAS) {
    const count = area === "dubai_marina" ? 15 : randomInt(10, 20);

    for (let i = 0; i < count; i++) {
      const name = `${pickRandom(firstNames)} ${pickRandom(lastNames)}`;

      let status: string;
      if (area === "dubai_marina") {
        // Anomaly: most Marina drivers are offline or busy
        status = weightedPick(DRIVER_STATUSES, [5, 30, 65]);
      } else {
        status = weightedPick(DRIVER_STATUSES, [50, 35, 15]);
      }

      drivers.push({
        name,
        area,
        status,
        last_seen: new Date(now - randomInt(0, 30 * 60 * 1000)),
      });
    }
  }

  return drivers;
}

function generateOrders(driverIds: Map<string, string[]>): Order[] {
  const orders: Order[] = [];
  const now = Date.now();

  for (let i = 0; i < 800; i++) {
    const area = pickRandom(AREAS);
    const createdAt = new Date(now - Math.random() * 3 * 60 * 60 * 1000);
    const ageMs = now - createdAt.getTime();
    const estimatedMin = randomInt(15, 45);

    // Anomaly: Dubai Marina orders in the last hour are heavily delayed
    const isAnomaly = area === "dubai_marina" && ageMs < 60 * 60 * 1000;

    let actualMin: number | null;
    let status: string;
    let delayReason: string | null = null;

    if (isAnomaly) {
      actualMin = estimatedMin + randomInt(20, 50);
      status = weightedPick(
        ["pending", "assigned", "delivered", "cancelled"] as const,
        [35, 30, 20, 15],
      );
      delayReason = weightedPick(
        ["no_driver", "no_driver", "traffic", "weather"] as const,
        [50, 25, 15, 10],
      );
    } else {
      const variance = randomInt(-5, 10);
      actualMin = estimatedMin + variance;
      status = weightedPick(STATUSES, [10, 15, 15, 55, 5]);
      if (variance > 5) {
        delayReason = pickRandom(DELAY_REASONS);
      }
    }

    if (status === "pending" || status === "assigned") {
      actualMin = null;
    }

    const areaDrivers = driverIds.get(area) ?? [];
    const driverId = status !== "pending" && areaDrivers.length > 0
      ? pickRandom(areaDrivers)
      : null;

    orders.push({
      type: pickRandom(ORDER_TYPES),
      status,
      area,
      created_at: createdAt,
      estimated_delivery_min: estimatedMin,
      actual_delivery_min: actualMin,
      driver_id: driverId,
      delay_reason: delayReason,
    });
  }

  return orders;
}

async function main() {
  const signer = new DsqlSigner({ hostname: DSQL_ENDPOINT!, region: REGION });
  const token = await signer.getDbConnectAdminAuthToken();

  const client = new pg.Client({
    host: DSQL_ENDPOINT,
    port: 5432,
    user: "admin",
    password: token,
    database: "postgres",
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  console.log("Connected to DSQL");

  console.log("Creating schema...");
  for (const stmt of SCHEMA_STATEMENTS) {
    await client.query(stmt);
  }

  console.log("Inserting drivers...");
  const drivers = generateDrivers();
  const driverIds = new Map<string, string[]>();

  for (const d of drivers) {
    const result = await client.query(
      `INSERT INTO drivers (name, area, status, last_seen) VALUES ($1, $2, $3, $4) RETURNING id`,
      [d.name, d.area, d.status, d.last_seen],
    );
    const id = result.rows[0].id as string;
    if (!driverIds.has(d.area)) driverIds.set(d.area, []);
    driverIds.get(d.area)!.push(id);
  }
  console.log(`Inserted ${drivers.length} drivers`);

  console.log("Inserting orders...");
  const orders = generateOrders(driverIds);

  for (const o of orders) {
    await client.query(
      `INSERT INTO orders (type, status, area, created_at, estimated_delivery_min, actual_delivery_min, driver_id, delay_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [o.type, o.status, o.area, o.created_at, o.estimated_delivery_min, o.actual_delivery_min, o.driver_id, o.delay_reason],
    );
  }
  console.log(`Inserted ${orders.length} orders`);

  await client.end();
  console.log("Done. Anomaly: dubai_marina has driver shortage + delayed orders in the last hour.");
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
