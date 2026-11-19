// test/FakeGemini.js — a local stand-in for the Gemini REST API.
//
// models: { [id]: behavior } where behavior is one of
//   'ok' | 'quota_rpm' | 'quota_rpd' | 'gone' | 'rejected' | 'forbidden' | 'error500'
//   | 'slow' (answers after 5 s) | 'stall' (sends headers, never finishes the body)
// Only IDs present in `models` are listed by ListModels; `calls` records
// every generateContent call as { id, prompt }.

import http from 'node:http';

export async function startFakeGemini(models = {}) {
  const fake = { models, calls: [], listCalls: 0, url: null, close: null };

  const server = http.createServer(async (req, res) => {
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };

    if (req.headers['x-goog-api-key'] !== 'test-key') return send(400, { error: { message: 'API key not valid' } });

    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/v1beta/models') {
      fake.listCalls++;
      return send(200, {
        models: Object.keys(fake.models).map(id => ({ name: `models/${id}`, supportedGenerationMethods: ['generateContent'] })),
      });
    }

    const match = url.pathname.match(/^\/v1beta\/models\/([^:]+):generateContent$/);
    if (req.method !== 'POST' || !match) return send(404, { error: { message: 'not found' } });

    let body = '';
    for await (const chunk of req) body += chunk;
    const id     = match[1];
    const prompt = JSON.parse(body).contents[0].parts[0].text;
    fake.calls.push({ id, prompt });

    switch (fake.models[id]) {
      case 'ok':
        return send(200, { candidates: [{ content: { parts: [{ text: `${id} says: ${prompt}` }] }, finishReason: 'STOP' }] });
      case 'quota_rpm':
        return send(429, { error: { message: 'Quota exceeded', details: [{ metadata: { quota_metric: 'generativelanguage.googleapis.com/generate_requests_per_model/qpm' } }] } }, { 'Retry-After': '30' });
      case 'quota_rpd':
        return send(429, { error: { message: 'Quota exceeded per day', details: [{ metadata: { quota_metric: 'generativelanguage.googleapis.com/generate_requests_per_model/qpd' } }] } });
      case 'rejected':  return send(400, { error: { message: 'Invalid argument' } });
      case 'forbidden': return send(403, { error: { message: 'Permission denied' } });
      case 'error500':  return send(500, { error: { message: 'Internal' } });
      case 'slow':      return setTimeout(() => send(200, { candidates: [] }), 5_000);
      case 'stall':     // headers and the start of the body, then nothing
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.write('{"candidates":');
      default:          return send(404, { error: { message: `models/${id} is not found` } });
    }
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  fake.url   = `http://127.0.0.1:${server.address().port}/v1beta/`;
  fake.close = () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
  return fake;
}
