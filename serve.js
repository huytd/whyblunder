#!/usr/bin/env node
/**
 * serve.js - Zero-dependency local server for WhyBlunder.
 *
 * Serves the static app (like `python3 -m http.server`) and the optional
 * /api/commentary endpoint (api/commentary.js), which needs the LLM_*
 * environment variables. Values in a .env file next to this script are
 * loaded too (they never override variables already set).
 *
 *   LLM_MODEL=gpt-4o-mini LLM_API_KEY=sk-... node serve.js     # http://localhost:3030
 *   PORT=8080 node serve.js
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;

function loadDotEnv(file) {
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch (e) {
        return;
    }
    text.split(/\r?\n/).forEach(line => {
        const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (!m || process.env[m[1]] !== undefined) return;
        let value = m[2];
        if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
        else value = value.replace(/\s+#.*$/, '');
        process.env[m[1]] = value;
    });
}

loadDotEnv(path.join(ROOT, '.env'));

const commentary = require('./api/commentary.js');

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.wasm': 'application/wasm',
    '.md': 'text/markdown; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8'
};

function notFound(res) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Not found');
}

function serveStatic(req, res, pathname) {
    let rel;
    try {
        rel = decodeURIComponent(pathname);
    } catch (e) {
        return notFound(res);
    }
    // No dotfiles (.env, .git) and nothing outside the repository.
    if (rel.split('/').some(part => part.startsWith('.'))) return notFound(res);
    let file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT + path.sep) && file !== ROOT) return notFound(res);
    fs.stat(file, (err, stat) => {
        if (!err && stat.isDirectory()) {
            file = path.join(file, 'index.html');
        } else if (err) {
            return notFound(res);
        }
        fs.readFile(file, (readErr, data) => {
            if (readErr) return notFound(res);
            res.statusCode = 200;
            res.setHeader('Content-Type', TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream');
            res.setHeader('Cache-Control', 'no-cache');
            if (req.method === 'HEAD') return res.end();
            res.end(data);
        });
    });
}

const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/api/commentary' || pathname === '/api/commentary/') {
        commentary(req, res).catch(err => {
            if (!res.headersSent) {
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                res.end(JSON.stringify({ error: err.message || String(err) }));
            } else {
                res.end();
            }
        });
        return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.statusCode = 405;
        return res.end();
    }
    serveStatic(req, res, pathname);
});

const port = parseInt(process.env.PORT, 10) || 3030;
server.listen(port, () => {
    const cfg = commentary.readConfig();
    console.log(`WhyBlunder running at http://localhost:${port}`);
    console.log(cfg.enabled
        ? `Commentary: ${cfg.model} via ${cfg.baseUrl}`
        : 'Commentary: off (set LLM_MODEL and LLM_API_KEY, or LLM_BASE_URL for a local endpoint)');
});
