// The HTTP server the tests fetch from: listening on 127.0.0.1, reached as
// `base` (localhost, so policies need `privateNetworks`), closed after the
// test file.
import { after } from 'node:test';
import { createServer } from 'node:http';

/** Responses to /hang that the client closed before they ended. */
export const hung = { closedEarly: 0 };

export const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    if (req.url === '/json') return res.writeHead(200, { 'content-type': 'application/json', 'x-a': '1' }).end('{"hi":"wörld"}');
    if (req.url === '/echo') {
      return res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({ method: req.method, headers: req.headers, body: body.toString('base64') }),
      );
    }
    if (req.url === '/big') return res.writeHead(200).end(Buffer.alloc(2048));
    if (req.url === '/bytes') return res.end(Buffer.from([0, 1, 2, 254, 255]));
    if (req.url === '/no-content') return res.writeHead(204).end();
    if (req.url === '/to-json') return res.writeHead(302, { location: '/json' }).end();
    if (req.url === '/to-echo') return res.writeHead(307, { location: '/echo' }).end();
    if (req.url === '/to-other-origin') return res.writeHead(307, { location: `http://127.0.0.1:${server.address().port}/echo` }).end();
    if (req.url === '/to-evil') return res.writeHead(302, { location: 'http://evil.example/' }).end();
    if (req.url === '/slow') return setTimeout(() => res.end('late'), 2000);
    if (req.url === '/stream') {
      res.write('one ');
      setTimeout(() => res.write('two '), 30);
      setTimeout(() => res.end('three'), 60);
      return;
    }
    if (req.url === '/hang') {
      res.write('start');
      res.on('close', () => hung.closedEarly++);
      return; // never ends
    }
    res.writeHead(404).end('nope');
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
after(() => server.close());

export const base = `http://localhost:${server.address().port}`;
