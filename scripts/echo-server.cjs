const http = require('node:http');
const server = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const url = new URL(request.url, 'http://127.0.0.1:4319');
  if (url.pathname === '/slow') await new Promise((resolve) => setTimeout(resolve, 10000));
  response.writeHead(url.pathname === '/error' ? 422 : 200, {
    'Content-Type': 'application/json',
    'X-Engine-Test': 'local',
  });
  response.end(
    JSON.stringify(
      {
        ok: true,
        method: request.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      },
      null,
      2,
    ),
  );
});
server.listen(4319, '127.0.0.1', () => console.log('Local echo server: http://127.0.0.1:4319/echo'));
