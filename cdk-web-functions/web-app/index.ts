import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const TABLE_NAME = process.env.TABLE_NAME!;
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const server = createServer(async (req, res) => {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  try {
    if (req.method === 'GET' && req.url === '/notes') {
      const { Items = [] } = await db.send(new ScanCommand({ TableName: TABLE_NAME }));
      return send(200, Items);
    }
    if (req.method === 'POST' && req.url === '/notes') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const { title, content = '' } = JSON.parse(raw || '{}');
      if (!title) return send(400, { message: 'title is required' });
      const note = { id: randomUUID(), title, content, createdAt: new Date().toISOString() };
      await db.send(new PutCommand({ TableName: TABLE_NAME, Item: note }));
      return send(201, note);
    }
    // Giả lập I/O chờ 1s: nhiều request cùng chia sẻ 1 environment
    if (req.method === 'GET' && req.url === '/slow') {
      await new Promise((r) => setTimeout(r, 1000));
      return send(200, { at: new Date().toISOString() });
    }
    send(404, { message: 'not found' });
  } catch (err) {
    console.error(err);
    send(500, { message: 'internal error' });
  }
});

// Lambda cho biết host:port cần listen qua AWS_LAMBDA_HTTP_ENDPOINT
const [host, port] = (process.env.AWS_LAMBDA_HTTP_ENDPOINT || '127.0.0.1:3000').split(':');
server.listen(Number(port), host, () => console.log(`listening on ${host}:${port}`));
process.on('SIGTERM', () => server.close());
