import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SESClient } from "@aws-sdk/client-ses";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

/*
 * Clients are created once per Lambda container and reused across invocations.
 *
 * No endpoint is hard-coded: inside LocalStack, Lambda containers receive
 * AWS_ENDPOINT_URL, which the AWS SDK v3 picks up automatically. The same code
 * therefore runs unchanged against real AWS.
 */
let dynamo: DynamoDBDocumentClient | undefined;
let ses: SESClient | undefined;
let cognito: CognitoIdentityProviderClient | undefined;

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

export function getCognitoClient(): CognitoIdentityProviderClient {
  cognito ??= new CognitoIdentityProviderClient({});
  return cognito;
}
