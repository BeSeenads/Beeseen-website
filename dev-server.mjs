import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 8080);

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;

  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key && process.env[key] == null) process.env[key] = value;
  }
}

loadEnv(path.join(root, '.env.local'));
loadEnv(path.join(root, '.env'));

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res, status, data) {
  send(res, status, JSON.stringify(data), {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/config') {
    sendJson(res, 200, {
      supabaseUrl: process.env.SUPABASE_URL || '',
      supabasePublishableKey: process.env.SUPABASE_PUBLISHABLE_KEY || ''
    });
    return;
  }

  const name = url.pathname.replace(/^\/api\//, '').replace(/\/$/, '');
  const filePath = path.join(root, 'api', `${name}.js`);

  if (!fs.existsSync(filePath)) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }

  const mod = await import(pathToFileURL(filePath).href);
  const method = (req.method || 'GET').toUpperCase();

  if (typeof mod.default === 'function') {
    const vercelReq = Object.assign(req, {
      query: Object.fromEntries(url.searchParams),
      body: undefined
    });

    if (method !== 'GET' && method !== 'HEAD') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        vercelReq.body = raw ? JSON.parse(raw) : {};
      } catch {
        vercelReq.body = raw;
      }
    }

    const vercelRes = {
      setHeader(key, value) {
        res.setHeader(key, value);
      },
      status(code) {
        res.statusCode = code;
        return vercelRes;
      },
      json(data) {
        sendJson(res, res.statusCode || 200, data);
      },
      end(data) {
        res.end(data);
      }
    };

    await mod.default(vercelReq, vercelRes);
    return;
  }

  const handler = mod[method] || (method === 'HEAD' ? mod.GET : null);
  if (typeof handler !== 'function') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  const webRequest = new Request(`http://127.0.0.1:${port}${url.pathname}${url.search}`, {
    method,
    headers: req.headers
  });

  const webResponse = await handler(webRequest);
  const body = Buffer.from(await webResponse.arrayBuffer());
  const headers = Object.fromEntries(webResponse.headers.entries());
  send(res, webResponse.status, body, headers);
}

function serveStatic(req, res, url) {
  let relative = decodeURIComponent(url.pathname);
  if (relative === '/') relative = '/entry.html';

  const filePath = path.normalize(path.join(root, relative));
  if (!filePath.startsWith(root)) {
    send(res, 403, 'Forbidden');
    return;
  }

  fs.stat(filePath, (error, stats) => {
    if (error || !stats.isFile()) {
      send(res, 404, 'Not found');
      return;
    }

    const type = mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);

  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }

    serveStatic(req, res, url);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) {
      sendJson(res, 500, { error: error.message || 'Server error' });
    }
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`BeSeen local server running at http://127.0.0.1:${port}/`);
});
