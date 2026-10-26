/**
 * game-commentary.js - Agadmator-style move-by-move commentary for WhyBlunder.
 *
 * The analyzed game goes out as the annotated PGN (PgnExport, every engine
 * line included) to an OpenAI-compatible chat completions API. The model
 * answers in a light section format, one header per move it talks about:
 *
 *   @@ intro
 *   Hello everyone and welcome to ...
 *   @@ 1. e4
 *   ...
 *   @@ 12... Nxd5
 *   ...
 *   @@ outro
 *   ...
 *
 * A section covers its move and the quiet moves after it, up to the next
 * header, so the UI can show "the commentary for this move" while the
 * player steps through the game (and while the text is still streaming).
 *
 * Shared by the browser (parsing, cache) and api/commentary.js (prompt,
 * SSE decoding). Pure: no DOM, no network.
 */
(function(root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.GameCommentary = factory();
    }
}(typeof self !== 'undefined' ? self : this, function() {
    'use strict';

    const USER_PROMPT = 'this PGN has all the analysis/variations, can you provide a Agadmator style commentary move by move. when there is information about the better line or bad line, go through it and explain.';

    const SYSTEM_PROMPT = [
        'You are a chess commentator in the style of Agadmator (Antonio Radić): warm, enthusiastic and conversational,',
        'opening with "Hello everyone and welcome", walking the viewer through the game move by move, pausing on the',
        'critical moments to show what would have happened in the side lines ("but the point is...", "and if...").',
        'The PGN you get is annotated by Stockfish: [%eval] tags (White\'s point of view), NAGs (?! ? ?? ! !!),',
        'comments with the verdict, the best move and why, and variations with the engine lines and the punishment lines.',
        'Base every claim on that analysis: never invent evaluations, never call a move a mistake the annotations do not',
        'flag, and write variations in standard algebraic notation (e.g. 14. Nxe5 dxe5 15. Qh5).'
    ].join(' ');

    const FORMAT_RULES = [
        'Answer in plain text (no markdown headings, no tables), split into sections. Each section starts with a header line',
        'that begins with "@@" and nothing else on that line:',
        '- "@@ intro" first: greet the viewers and introduce the players, the opening and what to expect.',
        '- "@@ <move>" for a move, copying the move number and the move from the main line exactly, e.g. "@@ 1. e4" for a',
        '  White move and "@@ 12... Nxd5" for a Black move.',
        '- "@@ outro" last: wrap up the game and the lessons, the way Agadmator ends his videos.',
        'A section covers its move and the quiet moves after it until the next header, so you may group a few quiet moves',
        'in one section, but every move marked ?!, ?, ??, ! or !! needs its own section, and so does every move the',
        'opponent could have punished. Go through the better line and the bad line given in the variations and explain them.',
        'Keep each section to a few sentences, and the sections in game order.'
    ].join('\n');

    const MAX_PGN_CHARS = 200000;
    const STORAGE_KEY = 'whyblunder_commentary_v1';
    const MAX_STORED = 8;

    /** Chat messages for the annotated PGN (OpenAI chat completions format). */
    function buildMessages(pgn, options) {
        const opts = options || {};
        const prompt = opts.prompt ? String(opts.prompt) : USER_PROMPT;
        return [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: `${prompt}\n\n${FORMAT_RULES}\n\nPGN:\n${String(pgn || '').trim()}\n` }
        ];
    }

    /** '@@ 12... Nxd5' -> { number: 12, white: false, san: 'Nxd5' }; '@@ intro' -> { kind: 'intro' }; null otherwise. */
    function parseHeader(line) {
        const m = String(line || '').match(/^[\s*_#>]*@@\s*(.*?)[\s*_]*$/);
        if (!m) return null;
        const body = m[1].replace(/[*_]/g, '').trim();
        const word = body.toLowerCase().replace(/[^a-z]/g, '');
        if (word === 'intro' || word === 'outro' || word === 'error') return { kind: word };
        const mv = body.match(/^(\d+)\s*(\.\s*\.\s*\.|…|\.)?\s*(.*)$/);
        if (!mv) return null;
        const dots = (mv[2] || '.').replace(/\s/g, '');
        const san = (mv[3] || '').trim().split(/\s+/)[0] || '';
        // "12 ... Nxd5" or "12... Nxd5" is Black; "12. Nxd5" is White.
        return { kind: 'move', number: parseInt(mv[1], 10), white: !(dots === '...' || dots === '…'), san: san.replace(/^\.+/, '') };
    }

    /**
     * Split the model's answer (complete or still streaming) into sections.
     * Text before the first header counts as the intro.
     */
    function parse(text) {
        const out = { intro: '', outro: '', error: '', sections: [] };
        let current = { kind: 'intro', lines: [] };
        const flush = () => {
            const body = current.lines.join('\n').replace(/^\s+|\s+$/g, '');
            if (current.kind === 'move') {
                out.sections.push({ number: current.number, white: current.white, san: current.san, text: body });
            } else if (body) {
                out[current.kind] = out[current.kind] ? `${out[current.kind]}\n\n${body}` : body;
            }
        };
        String(text || '').replace(/\r\n?/g, '\n').split('\n').forEach(line => {
            const header = parseHeader(line);
            if (header) {
                flush();
                current = Object.assign({ lines: [] }, header);
            } else {
                current.lines.push(line);
            }
        });
        flush();
        return out;
    }

    function bareSan(san) {
        return String(san || '').replace(/[?!+#]+$/g, '');
    }

    /** Index in moves of move number `number` for the given side (-1 when absent). */
    function moveIndex(moves, number, white) {
        const list = moves || [];
        for (let i = 0; i < list.length; i++) {
            const m = list[i];
            if (m && Number(m.move_number) === number && Boolean(m.is_white) === Boolean(white)) return i;
        }
        return -1;
    }

    /**
     * Tie parsed sections to the game's moves. Sections whose header does not
     * name a move of the game (or name one out of order) are folded into the
     * previous section so no text is lost.
     */
    function attach(parsed, moves) {
        const p = parsed || parse('');
        const sections = [];
        p.sections.forEach(s => {
            let index = moveIndex(moves, s.number, s.white);
            // "@@ 12. Nxd5" for Black's 12th move: trust the SAN when the side is wrong.
            if (index >= 0 && s.san && bareSan(moves[index].move) !== bareSan(s.san)) {
                const other = moveIndex(moves, s.number, !s.white);
                if (other >= 0 && bareSan(moves[other].move) === bareSan(s.san)) index = other;
            }
            const last = sections[sections.length - 1];
            if (index < 0 || (last && index <= last.index)) {
                if (last && s.text) last.text = last.text ? `${last.text}\n\n${s.text}` : s.text;
                return;
            }
            sections.push({ index, text: s.text });
        });
        return { intro: p.intro, outro: p.outro, error: p.error, sections };
    }

    /**
     * Commentary to show at move `index` (-1 = start position).
     * { text, start, continued, intro, outro } or null when the commentator
     * has not got there (yet).
     */
    function forMove(attached, index, totalMoves) {
        if (!attached) return null;
        const res = { text: '', start: -1, continued: false, intro: '', outro: '' };
        if (index < 0) {
            if (!attached.intro) return null;
            res.intro = attached.intro;
            return res;
        }
        let section = null;
        attached.sections.forEach(s => { if (s.index <= index) section = s; });
        if (section) {
            res.text = section.text;
            res.start = section.index;
            res.continued = section.index !== index;
        }
        if (typeof totalMoves === 'number' && index === totalMoves - 1 && attached.outro) res.outro = attached.outro;
        return (res.text || res.outro) ? res : null;
    }

    /**
     * Incremental decoder for an OpenAI-style SSE stream. Feed it text chunks;
     * it returns the content deltas found so far and remembers partial lines.
     */
    function createSseDecoder() {
        let buffer = '';
        let done = false;
        function take(line) {
            const m = line.match(/^data:\s?(.*)$/);
            if (!m) return '';
            const data = m[1].trim();
            if (!data) return '';
            if (data === '[DONE]') { done = true; return ''; }
            try {
                const json = JSON.parse(data);
                if (json.error) throw new Error(json.error.message || String(json.error));
                const choice = json.choices && json.choices[0];
                if (!choice) return '';
                const delta = choice.delta || choice.message || {};
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
            get done() { return done; }
        };
    }

    /** Content of a non-streaming chat completion response. */
    function completionText(json) {
        const choice = json && json.choices && json.choices[0];
        if (!choice) return '';
        if (choice.message && typeof choice.message.content === 'string') return choice.message.content;
        return typeof choice.text === 'string' ? choice.text : '';
    }

    function getStorage(storage) {
        if (storage) return storage;
        try {
            if (typeof localStorage !== 'undefined') return localStorage;
        } catch (e) {}
        return null;
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

    /** Saved commentary for a game key: { text, model, savedAt } or null. */
    function load(key, storage) {
        const entry = readAll(storage)[key];
        return entry && typeof entry.text === 'string' ? entry : null;
    }

    /** Save commentary for a game key, keeping the MAX_STORED most recent games. */
    function save(key, entry, storage) {
        const s = getStorage(storage);
        if (!s || !key) return false;
        const data = readAll(s);
        data[key] = Object.assign({}, entry, { savedAt: entry.savedAt || Date.now() });
        const keys = Object.keys(data).sort((a, b) => (data[b].savedAt || 0) - (data[a].savedAt || 0));
        keys.slice(MAX_STORED).forEach(k => { delete data[k]; });
        try {
            s.setItem(STORAGE_KEY, JSON.stringify(data));
            return true;
        } catch (e) {
            return false;
        }
    }

    function remove(key, storage) {
        const s = getStorage(storage);
        if (!s) return;
        const data = readAll(s);
        delete data[key];
        try { s.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (e) {}
    }

    return {
        USER_PROMPT,
        SYSTEM_PROMPT,
        FORMAT_RULES,
        MAX_PGN_CHARS,
        STORAGE_KEY,
        buildMessages,
        parseHeader,
        parse,
        moveIndex,
        attach,
        forMove,
        createSseDecoder,
        completionText,
        load,
        save,
        remove
    };
}));
