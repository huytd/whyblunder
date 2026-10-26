/**
 * api/commentary.js - LLM proxy for the Agadmator-style game commentary.
 *
 * Runs as a Vercel serverless function (api/ directory) and under the local
 * dev server (serve.js). It keeps the API key on the server: the browser only
 * sends the annotated PGN, the prompt is built here (GameCommentary), and the
 * model's answer is streamed back as plain text.
 *
 *   GET  /api/commentary  -> { enabled, model }
 *   POST /api/commentary  { pgn } -> text/plain stream of the commentary
 *
 * Configuration (environment variables, OpenAI-compatible API):
 *   LLM_BASE_URL       e.g. https://api.openai.com/v1 (default), https://openrouter.ai/api/v1,
 *                      http://localhost:11434/v1 (Ollama). /chat/completions is appended.
 *   LLM_MODEL          model name (required), e.g. gpt-4o-mini
 *   LLM_API_KEY        bearer token (optional for local servers)
 *   LLM_TEMPERATURE    optional, e.g. 0.7
 *   LLM_MAX_TOKENS     optional, e.g. 8000
 *   LLM_TIMEOUT_MS     optional, default 280000
 *   LLM_EXTRA_HEADERS  optional JSON object of extra request headers
 *   LLM_AUTOSTART      optional, "1" starts the commentary as soon as an analysis is ready
 * OPENAI_BASE_URL, OPENAI_MODEL and OPENAI_API_KEY are read as fallbacks.
 */
'use strict';

const GameCommentary = require('../js/game-commentary.js');

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

function readConfig(env) {
    const e = env || process.env;
    const pick = (...names) => {
        for (const n of names) {
            if (e[n] !== undefined && String(e[n]).trim() !== '') return String(e[n]).trim();
        }
        return '';
    };
    const explicitBase = pick('LLM_BASE_URL', 'OPENAI_BASE_URL');
    const num = (v) => (v === '' || !isFinite(Number(v)) ? null : Number(v));
    let extraHeaders = {};
    const rawHeaders = pick('LLM_EXTRA_HEADERS');
    if (rawHeaders) {
        try {
            const parsed = JSON.parse(rawHeaders);
            if (parsed && typeof parsed === 'object') extraHeaders = parsed;
        } catch (err) {
            extraHeaders = {};
        }
    }
    const config = {
        baseUrl: (explicitBase || DEFAULT_BASE_URL).replace(/\/+$/, ''),
        model: pick('LLM_MODEL', 'OPENAI_MODEL'),
        apiKey: pick('LLM_API_KEY', 'OPENAI_API_KEY'),
        temperature: num(pick('LLM_TEMPERATURE')),
        maxTokens: num(pick('LLM_MAX_TOKENS')),
        timeoutMs: num(pick('LLM_TIMEOUT_MS')) || 280000,
        extraHeaders,
        autoStart: /^(1|true|yes|on)$/i.test(pick('LLM_AUTOSTART'))
    };
    // A model is always needed; a key unless the endpoint was chosen explicitly (local servers).
    config.enabled = Boolean(config.model && (config.apiKey || explicitBase));
    return config;
}

function sendJson(res, status, body) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(body));
}

function readBody(req) {
    if (req.body !== undefined && req.body !== null) {
        if (typeof req.body === 'string') return Promise.resolve(req.body);
        if (Buffer.isBuffer(req.body)) return Promise.resolve(req.body.toString('utf8'));
        return Promise.resolve(req.body);
    }
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (c) => {
            size += c.length;
            if (size > GameCommentary.MAX_PGN_CHARS * 4) {
                reject(new Error('Request too large'));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

async function handler(req, res, env) {
    const config = readConfig(env);

    if (req.method === 'GET') {
        return sendJson(res, 200, { enabled: config.enabled, model: config.enabled ? config.model : '', autoStart: config.enabled && config.autoStart });
    }
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'GET, POST');
        return sendJson(res, 405, { error: 'Method not allowed' });
    }
    if (!config.enabled) {
        return sendJson(res, 503, { error: 'Commentary is not configured: set LLM_MODEL and LLM_API_KEY (and LLM_BASE_URL for non-OpenAI endpoints).' });
    }

    let body;
    try {
        body = await readBody(req);
        if (typeof body === 'string') body = JSON.parse(body || '{}');
    } catch (err) {
        return sendJson(res, 400, { error: 'Invalid request body' });
    }
    const pgn = body && typeof body.pgn === 'string' ? body.pgn : '';
    if (!pgn.trim()) return sendJson(res, 400, { error: 'Missing pgn' });
    if (pgn.length > GameCommentary.MAX_PGN_CHARS) return sendJson(res, 413, { error: 'PGN too large' });

    const payload = {
        model: config.model,
        messages: GameCommentary.buildMessages(pgn),
        stream: true
    };
    if (config.temperature !== null) payload.temperature = config.temperature;
    if (config.maxTokens !== null) payload.max_tokens = config.maxTokens;

    const headers = Object.assign({ 'Content-Type': 'application/json', Accept: 'text/event-stream, application/json' }, config.extraHeaders);
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, config.timeoutMs);
    let finished = false;
    res.on('close', () => { if (!finished) controller.abort(); });

    let upstream;
    try {
        upstream = await fetch(`${config.baseUrl}/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: controller.signal
        });
    } catch (err) {
        clearTimeout(timer);
        if (res.destroyed) return undefined;
        return sendJson(res, 502, { error: timedOut ? 'The LLM API took too long to answer.' : `Could not reach the LLM API: ${err.message || err}` });
    }

    if (!upstream.ok) {
        clearTimeout(timer);
        let detail = '';
        try { detail = (await upstream.text()).slice(0, 500); } catch (err) {}
        try {
            const json = JSON.parse(detail);
            if (json && json.error) detail = json.error.message || JSON.stringify(json.error);
        } catch (err) {}
        return sendJson(res, 502, { error: `LLM API error ${upstream.status}${detail ? `: ${detail}` : ''}` });
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('X-Commentary-Model', config.model);
    if (res.flushHeaders) res.flushHeaders();

    try {
        const type = upstream.headers.get('content-type') || '';
        if (type.includes('text/event-stream') && upstream.body) {
            const decoder = GameCommentary.createSseDecoder();
            const utf8 = new TextDecoder();
            for await (const chunk of upstream.body) {
                const text = decoder.push(utf8.decode(chunk, { stream: true }));
                if (text) res.write(text);
            }
            const tail = decoder.push(utf8.decode()) + decoder.end();
            if (tail) res.write(tail);
        } else {
            res.write(GameCommentary.completionText(await upstream.json()));
        }
    } catch (err) {
        if (!res.destroyed) {
            res.write(`\n@@ error\n${timedOut ? 'The LLM API took too long to answer.' : (err.message || String(err))}\n`);
        }
    } finally {
        finished = true;
        clearTimeout(timer);
        res.end();
    }
}

module.exports = handler;
module.exports.readConfig = readConfig;
