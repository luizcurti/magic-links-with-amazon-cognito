import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SESClient } from "@aws-sdk/client-ses";
import { SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

// One client per container. LocalStack injects AWS_ENDPOINT_URL, which the SDK reads.
let dynamo: DynamoDBDocumentClient | undefined;
let ses: SESClient | undefined;
let cognito: CognitoIdentityProviderClient | undefined;
let sqs: SQSClient | undefined;

export function getDynamoClient(): DynamoDBDocumentClient {
  dynamo ??= DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  return dynamo;
}

export function getSesClient(): SESClient {
  ses ??= new SESClient({});
  return ses;
}

export function getSqsClient(): SQSClient {
  sqs ??= new SQSClient({});
  return sqs;
}

export function getCognitoClient(): CognitoIdentityProviderClient {
  cognito ??= new CognitoIdentityProviderClient({});
  return cognito;
}
