/**
 * game-commentary.js - GothamChess-style move-by-move commentary for WhyBlunder.
 *
 * Commentary is written one move at a time, like a video where the viewer
 * only sees the board up to the current move. Every request carries the
 * whole annotated PGN (PgnExport, every engine line) so the model knows the
 * story of the game, then asks for the commentary of a single move with
 * that move's facts spelled out: the position, the moves so far, its
 * engine notes (PgnExport.moveNotes) and what was already said about the
 * previous moves. The PGN part is the same for every move of a game, so
 * APIs with prompt caching only pay for it once.
 *
 * The browser calls the API directly (stream()), with the base URL, model
 * and key the player saved in localStorage (loadSettings/saveSettings): the
 * key only goes to the endpoint they chose. No DOM; no network except stream().
 */
(function(root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.GameCommentary = factory();
    }
}(typeof self !== 'undefined' ? self : this, function() {
    'use strict';

    const SYSTEM_PROMPT = [
        'You are a chess commentator in the style of Levy Rozman (GothamChess): punchy, funny and direct, talking',
        'straight to the viewer, naming the tactics (fork, pin, skewer, discovered attack, back-rank mate...), hyping the',
        'great moves and roasting the blunders, always with the reason behind it.',
        '',
        'You commentate one move at a time, like a video where the viewer only sees the board up to the current move.',
        'You get the whole game annotated by a chess engine, and the engine notes for the move at hand. Those notes are',
        'your private preparation. The viewer never sees them, so do not read them out: turn them into explanations.',
        '',
        'Teach, do not recap. The viewer can already read the engine\'s one-line verdict, so do not just restate it',
        '("Nf6 was a mistake, g6 was better"). Add what it does not say: why the move works or fails, what each side is',
        'aiming for, where the alternatives lead, and the pattern to remember. Stay concrete: every sentence says something',
        'about the position; no filler, no warm-up ("Alright, let\'s see what happens here"), no questions to the viewer, no',
        'recap of earlier moves. Use the length you are given: short for quiet moves, room to explain at key moments.',
        '- Say what the move does: the plan, the piece it activates, the square or weakness it targets, the threat it',
        '  makes or stops.',
        '- For an inaccuracy, mistake or blunder, say exactly what goes wrong (the hanging piece, the tactic it allows, the',
        '  weakness it creates) and play the punishing line out, saying what its key moves achieve ("Nf6?? and Qxf7 is',
        '  mate: f7 was only defended by the king").',
        '- For the better move and the other alternatives in the notes, explain the idea behind them and how play would go',
        '  on (the plan, the threat, the kind of position it leads to), not only their names. When two moves are close,',
        '  say what makes them different.',
        '- For a great or brilliant move, say why it works and what goes wrong for the opponent after the natural replies.',
        '- When the opponent could have punished the previous move and did not, show what they missed and why it works.',
        '- End a key moment with a short takeaway: a pattern or rule of thumb the viewer can use in their own games.',
        '- Never quote evaluation numbers (+1.35, -0.61, #3) and never say "the engine says", "Stockfish evaluates",',
        '  "the computer gives" or "the evaluation is". Give the reason, not the verdict; when the overall picture matters,',
        '  say it in a few plain words ("White is just winning", "Black is up a piece").',
        '- Stay faithful to the notes and the position: do not invent tactics, threats or lines they do not support, and',
        '  only mention moves that are legal in the position.',
        '- Write moves in standard algebraic notation (e.g. 14. Nxe5 dxe5 15. Qh5).',
        '- Answer with the commentary itself: plain text, no heading, no move label, no notes about these instructions,',
        '  and no thinking out loud.'
    ].join('\n');

    const CRITICAL = ['inaccuracy', 'mistake', 'miss', 'blunder', 'brilliant', 'great'];

    const STORAGE_KEY = 'whyblunder_commentary_v5'; // v5: teaching commentary (v4: very short, v3: long, v1/v2: one-shot)
    const OLD_STORAGE_KEYS = ['whyblunder_commentary_v1', 'whyblunder_commentary_v2', 'whyblunder_commentary_v3', 'whyblunder_commentary_v4'];
    const SETTINGS_KEY = 'whyblunder_llm_settings_v1';
    const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
    const MAX_STORED = 8;

    function getPgnExport(override) {
        if (override) return override;
        if (typeof PgnExport !== 'undefined') return PgnExport;
        if (typeof window !== 'undefined' && window.PgnExport) return window.PgnExport;
        try {
            return require('./pgn-export.js');
        } catch (e) {
            return null;
        }
    }

    function bareSan(san) {
        return String(san || '').replace(/[?!+#]+$/g, '');
    }

    /** SAN as shown to the viewer: check and mate signs kept, ?! annotations dropped. */
    function displaySan(san) {
        return String(san || '').replace(/[?!]+$/g, '');
    }

    /** '12. Nxd5' / '12... Nxd5' for moves[index]. */
    function moveLabel(moves, index) {
        const m = moves && moves[index];
        if (!m) return '';
        return `${m.move_number}${m.is_white ? '.' : '...'} ${displaySan(m.move)}`;
    }

    /** '1. e4 c5 2. Bb5' for moves[0..index]. */
    function movesSoFar(moves, index) {
        const out = [];
        for (let i = 0; i <= index && i < moves.length; i++) {
            const m = moves[i];
            if (m.is_white) out.push(`${m.move_number}. ${displaySan(m.move)}`);
            else out.push(i === 0 ? `${m.move_number}... ${displaySan(m.move)}` : displaySan(m.move));
        }
        return out.join(' ');
    }

    function qualityKey(move) {
        const q = String((move && (move.detailed_quality || move.quality)) || '').toLowerCase().trim();
        if (q === 'missed win' || q === 'missed-win') return 'miss';
        return q;
    }

    function players(info) {
        const name = (n, elo) => `${n || '?'}${elo ? ` (${elo})` : ''}`;
        return `White: ${name(info.white, info.white_elo)}, Black: ${name(info.black, info.black_elo)}`;
    }

    /**
     * Chat messages asking for the commentary of moves[index] (-1 = the intro,
     * before the first move). The first two parts (system prompt, annotated
     * PGN) are identical for every move of a game, so they can be cached.
     *
     * @param {object} o
     *   pgn       the annotated PGN of the whole game (PgnExport.build, lines 'all')
     *   moves     analyzed moves (output contract in AGENTS.md)
     *   index     move to comment on, -1 for the intro
     *   gameInfo  { white, black, white_elo, black_elo, opening, eco, result }
     *   previous  [{ index, text }] what was already said, most recent last
     */
    function buildMoveMessages(o) {
        const moves = o.moves || [];
        const index = typeof o.index === 'number' ? o.index : -1;
        const info = o.gameInfo || {};
        const P = getPgnExport(o.PgnExport);
        const context = [
            'Here is the whole game, annotated by a chess engine: [%eval] tags, NAGs (?! ? ?? ! !!), comments with the',
            'verdict and the better move, and variations with the better lines and the punishment lines. Study it so you',
            'know the story of the game. You will comment on it one move at a time.',
            '',
            'PGN:',
            String(o.pgn || '').trim()
        ].join('\n');

        const task = [];
        if (index < 0) {
            task.push('The viewer is looking at the starting position. Give the intro before the first move in 2 or 3 sentences');
            task.push(`(at most 60 words): introduce the players (${players(info)})${info.opening ? ` and the opening (${info.opening}) with its main idea` : ''},`);
            task.push('without revealing the result or the key moments.');
        } else {
            const move = moves[index];
            const label = moveLabel(moves, index);
            const notes = P && P.moveNotes ? P.moveNotes(moves, index) : null;
            const key = qualityKey(move);
            const prev = index > 0 ? moves[index - 1] : null;
            const prevNotes = prev && P && P.moveNotes ? P.moveNotes(moves, index - 1) : null;
            const prevFlagged = prev && ['inaccuracy', 'mistake', 'miss', 'blunder'].includes(qualityKey(prev));
            const punishFirst = prevNotes && prevNotes.punishment ? bareSan(prevNotes.punishment.replace(/^\d+\.(\.\.)?\s*/, '').split(/\s+/)[0]) : '';
            const missedPunishment = Boolean(prevFlagged && punishFirst && punishFirst !== bareSan(move.move));
            const punishes = Boolean(prevFlagged && punishFirst && punishFirst === bareSan(move.move));
            const critical = CRITICAL.includes(key) || missedPunishment || punishes;

            task.push(`The board now shows ${label}, ${move.is_white ? 'White' : 'Black'}'s move ${move.move_number}. Give the commentary for this move only.`);
            task.push('');
            if (notes && notes.fenBefore) task.push(`Position before the move (FEN): ${notes.fenBefore}`);
            task.push(`Moves so far: ${movesSoFar(moves, index)}`);
            task.push('');
            task.push('Engine notes for this move (private, do not read them out):');
            task.push(`- Verdict: ${(notes && notes.quality) || key || 'good move'}`);
            if (notes && notes.comment) task.push(`- Comment: ${notes.comment}`);
            if (notes && notes.lines && notes.lines.length) task.push(`- Lines from the position before the move: ${notes.lines.join(' | ')}`);
            if (notes && notes.punishment) task.push(`- How the opponent can punish it: ${notes.punishment}`);
            if (missedPunishment) {
                task.push(`- The previous move, ${moveLabel(moves, index - 1)}, was a ${qualityKey(prev)}: it could have been punished with ${prevNotes.punishment}, and ${label} misses that.`);
            }
            if (punishes) {
                task.push(`- ${label} punishes the previous move, ${moveLabel(moves, index - 1)} (a ${qualityKey(prev)}).`);
            }
            const previous = (o.previous || []).filter(p => p && p.text);
            if (previous.length) {
                task.push('');
                task.push('What you already said (most recent last). Carry the story on; do not repeat it:');
                previous.forEach(p => task.push(`${p.index < 0 ? 'Intro' : moveLabel(moves, p.index)}: ${p.text.replace(/\s+/g, ' ').trim()}`));
            }
            task.push('');
            const hasAlternatives = Boolean(notes && notes.lines && notes.lines.length);
            if (critical) {
                task.push('This is a key moment: 4 to 6 sentences, at most 130 words. Teach it: why the move works or fails, the line that shows it (what its key moves do), the better move or the other alternatives in the notes and how play would go on after them, and end with a one-line takeaway.');
            } else if (key === 'book') {
                task.push('This is an opening (book) move: one sentence on the opening idea behind it, at most 25 words.');
            } else {
                task.push(`This is a normal move: 1 to 3 sentences, at most 60 words, on the idea behind it${hasAlternatives ? '. If an alternative in the notes shows a different plan, say briefly what it would have aimed for' : ''}.`);
            }
            task.push('Talk only about this move and the lines in its notes; do not mention moves that come later in the game.');
            if (index === moves.length - 1) {
                task.push(`This is the last move of the game${info.result ? ` (result ${info.result})` : ''}. After it, wrap up the game in 2 or 3 sentences: the turning point, how it was decided, and the main lesson to take away.`);
            }
        }
        task.push('Answer with the commentary text only.');

        return [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: `${context}\n\n---\n\n${task.join('\n')}` }
        ];
    }

    /**
     * True when the "commentary" is really a content-safety classifier's
     * verdict, e.g. NVIDIA NemoGuard's "User Safety: safe / Response Safety:
     * safe" (a guard model picked as the model, or a guardrail on the endpoint
     * replacing the answer). Such text must not be shown, saved, or fed back
     * as "what you already said", or the model starts copying it.
     */
    function isClassifierVerdict(text) {
        const t = String(text || '').trim();
        if (!t) return false;
        if (/^[{"\s]*(user|response|prompt)[ _]safety"?\s*:/i.test(t)) return true;
        if (/^\s*safety\s*:\s*(safe|unsafe|controversial)\b/i.test(t)) return true;
        // Llama Guard style: "safe", or "unsafe" plus category codes on the next line
        return t.length < 40 && /^(safe|unsafe)[\s.]*(\n|$)/i.test(t);
    }

    /**
     * The model's answer, ready to show: no <think> blocks (and nothing while
     * one is still open), no leading move label or heading, trimmed. With
     * `partial` (text still streaming), a first line that may turn out to be
     * a label ("**12... Nx") is held back until it is complete.
     */
    function cleanText(text, partial) {
        let t = String(text || '').replace(/\r\n?/g, '\n');
        t = t.replace(/<think>[\s\S]*?<\/think>/gi, '');
        const open = t.search(/<think>/i);
        if (open >= 0) t = t.slice(0, open);
        t = t.replace(/^\s+/, '');
        // "**12... Nxd5**", "12... Nxd5:", "@@ 12... Nxd5", "## Intro" on a line of their own
        t = t.replace(/^(?:[*_#>\s@]*(?:\d+\s*\.(?:\s*\.\s*\.)?\s*\S+|intro|commentary)[*_:\s]*\n)+/i, '');
        if (partial && !t.includes('\n') && t.length < 40 && /^[*_#>@]|^\d+\s*\.|^(intro|commentary)\b/i.test(t)) return '';
        return t.trim();
    }

    /**
     * Incremental decoder for an OpenAI-style SSE stream. Feed it text chunks;
     * it returns the content deltas found so far and remembers partial lines.
     * Reasoning deltas (reasoning_content / reasoning, sent by "thinking"
     * models before any content) are counted in `reasoningChars`.
     */
    function createSseDecoder() {
        let buffer = '';
        let done = false;
        let events = 0;
        let reasoningChars = 0;
        function take(line) {
            const m = line.match(/^data:\s?(.*)$/);
            if (!m) return '';
            const data = m[1].trim();
            if (!data) return '';
            events++;
            if (data === '[DONE]') { done = true; return ''; }
            try {
                const json = JSON.parse(data);
                if (json.error) throw new Error(json.error.message || String(json.error));
                const choice = json.choices && json.choices[0];
                if (!choice) return '';
                const delta = choice.delta || choice.message || {};
                const reasoning = delta.reasoning_content || delta.reasoning;
                if (typeof reasoning === 'string') reasoningChars += reasoning.length;
                return typeof delta.content === 'string' ? delta.content : (typeof choice.text === 'string' ? choice.text : '');
            } catch (e) {
                if (e instanceof SyntaxError) return '';
                throw e;
            }
        }
        return {
            push(chunk) {
                buffer += String(chunk || '');
                const lines = buffer.split(/\r?\n/);
                buffer = lines.pop();
                return lines.map(take).join('');
            },
            end() {
                const rest = buffer;
                buffer = '';
                return rest ? take(rest) : '';
            },
            get done() { return done; },
            get events() { return events; },
            get reasoningChars() { return reasoningChars; }
        };
    }

    /** Content of a non-streaming chat completion response. */
    function completionText(json) {
        const choice = json && json.choices && json.choices[0];
        if (!choice) return '';
        if (choice.message && typeof choice.message.content === 'string') return choice.message.content;
        return typeof choice.text === 'string' ? choice.text : '';
    }

    /** Trimmed settings: { baseUrl, model, apiKey }. Base URL without trailing slash. */
    function normalizeSettings(settings) {
        const s = settings || {};
        const str = v => (v === null || v === undefined ? '' : String(v).trim());
        return {
            baseUrl: (str(s.baseUrl) || DEFAULT_BASE_URL).replace(/\/+$/, '').replace(/\/chat\/completions$/, ''),
            model: str(s.model),
            apiKey: str(s.apiKey)
        };
    }

    /** A model is always needed; a key unless the endpoint is not the default one (local servers). */
    function isConfigured(settings) {
        const s = normalizeSettings(settings);
        return Boolean(s.model && (s.apiKey || s.baseUrl !== DEFAULT_BASE_URL));
    }

    /** fetch() arguments for a streaming chat completion of `messages`. */
    function buildRequest(settings, messages) {
        const s = normalizeSettings(settings);
        const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream, application/json' };
        if (s.apiKey) headers.Authorization = `Bearer ${s.apiKey}`;
        return {
            url: `${s.baseUrl}/chat/completions`,
            init: {
                method: 'POST',
                headers,
                body: JSON.stringify({ model: s.model, messages, stream: true })
            }
        };
    }

    /**
     * Ask the LLM for the commentary. Calls onText(fullTextSoFar) as the
     * answer streams in, onThinking(reasoningChars) while a reasoning model
     * thinks, and resolves with the full text. Rejects with a readable
     * message (HTTP errors, unreachable endpoint / CORS).
     *
     * The body is always read as it arrives, whatever its content-type says
     * (some servers stream SSE as text/plain or without a type): SSE "data:"
     * lines are decoded live, and a plain JSON completion (a server that
     * ignored stream: true) is parsed at the end.
     */
    async function stream(settings, messages, options) {
        const opts = options || {};
        const fetchImpl = opts.fetch || (typeof fetch !== 'undefined' ? fetch : null);
        if (!fetchImpl) throw new Error('fetch is not available');
        const req = buildRequest(settings, messages);
        let res;
        try {
            res = await fetchImpl(req.url, Object.assign({}, req.init, { signal: opts.signal }));
        } catch (e) {
            if (e && e.name === 'AbortError') throw e;
            throw new Error(`Could not reach ${req.url}. Check the base URL, and that the endpoint accepts requests from a browser (CORS).`);
        }
        if (!res.ok) {
            let detail = '';
            try { detail = (await res.text()).slice(0, 500); } catch (e) {}
            try {
                const json = JSON.parse(detail);
                if (json && json.error) detail = json.error.message || JSON.stringify(json.error);
            } catch (e) {}
            throw new Error(`The LLM API answered ${res.status}${detail ? `: ${detail}` : ''}`);
        }
        let text = '';
        const emit = (chunk) => {
            if (!chunk) return;
            text += chunk;
            if (opts.onText) opts.onText(text);
        };
        if (!res.body || !res.body.getReader) {
            emit(completionText(await res.json()));
            return text;
        }
        const decoder = createSseDecoder();
        const utf8 = new TextDecoder();
        const reader = res.body.getReader();
        let raw = '';
        let mode = ''; // 'sse' | 'json', decided by the first non-blank character
        let reasoningSeen = 0;
        const feed = (chunk) => {
            if (!mode) {
                raw += chunk;
                const first = raw.replace(/^\s+/, '').charAt(0);
                if (!first) return;
                mode = first === '{' || first === '[' ? 'json' : 'sse';
                chunk = raw;
                if (mode === 'sse') raw = '';
            } else if (mode === 'json') {
                raw += chunk;
                return;
            }
            if (mode === 'sse') {
                emit(decoder.push(chunk));
                if (decoder.reasoningChars !== reasoningSeen) {
                    reasoningSeen = decoder.reasoningChars;
                    if (!text && opts.onThinking) opts.onThinking(reasoningSeen);
                }
            }
        };
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            feed(utf8.decode(value, { stream: true }));
        }
        feed(utf8.decode());
        if (mode === 'sse') {
            emit(decoder.end());
        } else if (raw.trim()) {
            let json;
            try {
                json = JSON.parse(raw);
            } catch (e) {
                throw new Error('The LLM API sent a response that is neither a stream nor JSON.');
            }
            if (json && json.error) throw new Error(json.error.message || JSON.stringify(json.error));
            emit(completionText(json));
        }
        return text;
    }

    function getStorage(storage) {
        if (storage) return storage;
        try {
            if (typeof localStorage !== 'undefined') return localStorage;
        } catch (e) {}
        return null;
    }

    function loadSettings(storage) {
        const s = getStorage(storage);
        if (!s) return normalizeSettings({});
        try {
            return normalizeSettings(JSON.parse(s.getItem(SETTINGS_KEY) || '{}'));
        } catch (e) {
            return normalizeSettings({});
        }
    }

    function saveSettings(settings, storage) {
        const s = getStorage(storage);
        if (!s) return false;
        try {
            s.setItem(SETTINGS_KEY, JSON.stringify(normalizeSettings(settings)));
            return true;
        } catch (e) {
            return false;
        }
    }

    function clearSettings(storage) {
        const s = getStorage(storage);
        if (s) { try { s.removeItem(SETTINGS_KEY); } catch (e) {} }
    }

    function readAll(storage) {
        const s = getStorage(storage);
        if (!s) return {};
        try {
            const data = JSON.parse(s.getItem(STORAGE_KEY) || '{}');
            return data && typeof data === 'object' ? data : {};
        } catch (e) {
            return {};
        }
    }

    function writeAll(data, storage) {
        const s = getStorage(storage);
        if (!s) return false;
        const keys = Object.keys(data).sort((a, b) => (data[b].savedAt || 0) - (data[a].savedAt || 0));
        keys.slice(MAX_STORED).forEach(k => { delete data[k]; });
        try {
            if (s.removeItem) OLD_STORAGE_KEYS.forEach(k => s.removeItem(k));
            s.setItem(STORAGE_KEY, JSON.stringify(data));
            return true;
        } catch (e) {
            return false;
        }
    }

    /** Saved commentary of a game: { model, savedAt, moves: { [index]: text } } or null. */
    function loadGame(key, storage) {
        const entry = readAll(storage)[key];
        return entry && entry.moves && typeof entry.moves === 'object' ? entry : null;
    }

    /** Save the commentary of one move (-1 = intro), keeping the MAX_STORED most recent games. */
    function saveMove(key, index, text, model, storage) {
        if (!key) return false;
        const data = readAll(storage);
        const entry = data[key] && data[key].moves ? data[key] : { moves: {} };
        entry.moves[index] = text;
        if (model) entry.model = model;
        entry.savedAt = Date.now();
        data[key] = entry;
        return writeAll(data, storage);
    }

    function removeMove(key, index, storage) {
        const data = readAll(storage);
        if (!data[key] || !data[key].moves) return;
        delete data[key].moves[index];
        writeAll(data, storage);
    }

    return {
        SYSTEM_PROMPT,
        STORAGE_KEY,
        SETTINGS_KEY,
        DEFAULT_BASE_URL,
        buildMoveMessages,
        cleanText,
        isClassifierVerdict,
        moveLabel,
        movesSoFar,
        createSseDecoder,
        completionText,
        normalizeSettings,
        isConfigured,
        buildRequest,
        stream,
        loadSettings,
        saveSettings,
        clearSettings,
        loadGame,
        saveMove,
        removeMove
    };
}));
