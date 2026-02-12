import * as cdk from "aws-cdk-lib";
import * as dsql from "aws-cdk-lib/aws-dsql";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as iam from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";

interface AiChatStackProps extends cdk.StackProps {
  namespace: string;
}

export class AiChatStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AiChatStackProps) {
    super(scope, id, props);

    const ns = props.namespace;

    const cluster = new dsql.CfnCluster(this, "DsqlCluster", {
      deletionProtectionEnabled: false,
    });

    const agentFn = new lambda.Function(this, "AgentFn", {
      functionName: `${ns}-agent`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset("../lambda"),
      timeout: cdk.Duration.minutes(2),
      memorySize: 512,
      environment: {
        DSQL_ENDPOINT: cluster.attrEndpoint,
        DSQL_REGION: this.region,
      },
    });

    agentFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dsql:DbConnectAdmin"],
        resources: ["*"],
      })
    );

    agentFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModelWithResponseStream", "bedrock:InvokeModel"],
        resources: ["*"],
      })
    );

    const fnUrl = agentFn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      invokeMode: lambda.InvokeMode.RESPONSE_STREAM,
      cors: {
        allowedOrigins: ["*"],
        allowedMethods: [lambda.HttpMethod.GET, lambda.HttpMethod.POST],
        allowedHeaders: ["content-type"],
      },
    });

    new cdk.CfnOutput(this, "FunctionUrl", { value: fnUrl.url });
    new cdk.CfnOutput(this, "DsqlEndpoint", { value: cluster.attrEndpoint });
  }
}
