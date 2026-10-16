import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { randomUUID } from 'node:crypto';

const TABLE_NAME = process.env.TABLE_NAME!;
const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

interface Note {
  id: string;
  title: string;
  content: string;
  createdAt: string;
}

const response = (statusCode: number, body: unknown): APIGatewayProxyResult => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

async function createNote(body: string | null): Promise<APIGatewayProxyResult> {
  const { title, content = '' } = JSON.parse(body ?? '{}');
  if (!title) {
    return response(400, { message: 'title is required' });
  }

  const note: Note = {
    id: randomUUID(),
    title,
    content,
    createdAt: new Date().toISOString(),
  };
  await client.send(new PutCommand({ TableName: TABLE_NAME, Item: note }));
  return response(201, note);
}

async function getNote(id: string): Promise<APIGatewayProxyResult> {
  const { Item } = await client.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { id } }),
  );
  return Item ? response(200, Item) : response(404, { message: 'Note not found' });
}

async function listNotes(): Promise<APIGatewayProxyResult> {
  const { Items = [] } = await client.send(
    new ScanCommand({ TableName: TABLE_NAME, Limit: 50 }),
  );
  return response(200, Items);
}

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  try {
    const id = event.pathParameters?.id;

    switch (event.httpMethod) {
      case 'POST':
        return await createNote(event.body);
      case 'GET':
        return id ? await getNote(id) : await listNotes();
      default:
        return response(405, { message: 'Method not allowed' });
    }
  } catch (error) {
    console.error(error);
    return response(500, { message: 'Internal server error' });
  }
};
