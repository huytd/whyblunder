/**
 * game-commentary.js - GothamChess-style move-by-move commentary for WhyBlunder.
 *
 * Commentary is written one move at a time, like a video where the viewer
 * only sees the board up to the current move. Each request is small: the
 * game header and that move's facts (the position, the moves so far, its
 * engine notes from PgnExport.moveNotes), so it can be sent as soon as that
 * move is analyzed, while the engine is still working on the rest of the
 * game. Moves do not depend on each other's text, so any number of them
 * can be written at once.
 *
 * linkMoves() finds the moves the model wrote ("1...e6", "2.Nf3 d5",
 * "Qxf7#") and checks them with chess.js, so the UI can make them clickable.
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
        'You get the moves so far and a chess engine\'s notes for the move at hand (verdict, comment, better lines, the',
        'punishment). Those notes are your private preparation. The viewer never sees them, so do not read them out or',
        'refer to them: turn them into explanations.',
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
        '- Never quote evaluation numbers (+1.35, -0.61, #3) and never say "the engine says", "the engine notes",',
        '  "according to the notes", "Stockfish evaluates", "the computer gives" or "the evaluation is". Give the reason, not the verdict; when the overall picture matters,',
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
     * before the first move). Only moves[0..index] (and their analysis) are
     * needed, so a move can be commented on while later ones are still being
     * analyzed.
     *
     * @param {object} o
     *   moves     analyzed moves (output contract in AGENTS.md); later entries may be
     *             placeholders ({ move, move_number, is_white }) not analyzed yet
     *   pgn       optional: an annotated PGN of the whole game to send as context
     *   index     move to comment on, -1 for the intro
     *   gameInfo  { white, black, white_elo, black_elo, opening, eco, result }
     */
    function buildMoveMessages(o) {
        const moves = o.moves || [];
        const index = typeof o.index === 'number' ? o.index : -1;
        const info = o.gameInfo || {};
        const P = getPgnExport(o.PgnExport);
        const context = o.pgn ? [
            'Here is the whole game, annotated by a chess engine: [%eval] tags, NAGs (?! ? ?? ! !!), comments with the',
            'verdict and the better move, and variations with the better lines and the punishment lines. Study it so you',
            'know the story of the game. You will comment on it one move at a time.',
            '',
            'PGN:',
            String(o.pgn).trim()
        ].join('\n') : '';

        const task = [`Game: ${players(info)}${info.opening ? `. Opening: ${info.opening}` : ''}.`, ''];
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
            { role: 'user', content: `${context ? `${context}\n\n---\n\n` : ''}${task.join('\n')}` }
        ];
    }

    function getChessConstructor(override) {
        if (override) return override;
        if (typeof Chess !== 'undefined') return Chess;
        if (typeof window !== 'undefined' && window.Chess) return window.Chess;
        try {
            const c = require('./chess.min.js');
            return c.Chess || c;
        } catch (e) {
            return null;
        }
    }

    // "Nf3", "exd5", "Qxf7#", "O-O-O", "e8=Q+", optionally numbered: "12.", "12...", "12…"
    const SAN_BODY = '(?:O-O-O|O-O|[KQRBN][a-h]?[1-8]?x?[a-h][1-8]|[a-h](?:x[a-h])?[1-8](?:=?[QRBN])?)[+#]?[!?]*';
    const MOVE_TOKEN = `(?:\\b(\\d+)\\s*(\\.\\s*\\.\\s*\\.|\u2026|\\.)\\s*)?(?<![\\w-])(${SAN_BODY})(?![\\w-])`;

    /**
     * Find the chess moves in a commentary and check them on the board.
     * Moves written next to each other ("2.Nf3 d5 3.exd5") form a run; a run
     * starts from the end of an earlier run in the text (a line going on), or
     * from a position of the game up to the move on screen whose move number
     * and side match ("1...e6" = an alternative to Black's first move). Bare
     * moves ("Qxf7#") are tried from the position before the move on screen,
     * then after it. A lone pawn move that reads like a square ("e5") is only
     * linked when it is a move of the game and not a square ("on e5").
     * Unchecked text stays text.
     *
     * @param {string} text
     * @param {object} o  { moves: game moves (SAN strings or move objects), index: move on screen (-1 = start) }
     * @returns {{ segments: Array, lines: Array }}
     *   segments: { type: 'text', text } | { type: 'move', text, line, step, gameIndex }
     *     (gameIndex: the game move this is, when the line follows the game; else null)
     *   lines: { startFen, sans } (line = index in lines, step = index in sans)
     */
    function linkMoves(text, o) {
        const opts = o || {};
        const src = String(text || '');
        const ChessCtor = getChessConstructor(opts.Chess);
        const plain = { segments: src ? [{ type: 'text', text: src }] : [], lines: [] };
        if (!ChessCtor || !src) return plain;
        const game = (opts.moves || []).map(m => bareSan(typeof m === 'string' ? m : (m && m.move)));
        const index = typeof opts.index === 'number' ? opts.index : -1;

        // positions[k] = before game move k, up to the position after the move on screen
        const positions = [];
        const board = new ChessCtor();
        positions.push(board.fen());
        for (let i = 0; i <= index && i < game.length; i++) {
            let m = null;
            try { m = board.move(game[i]); } catch (e) { m = null; }
            if (!m) break;
            positions.push(board.fen());
        }
        const side = fen => fen.split(' ')[1];
        const number = fen => parseInt(fen.split(' ')[5], 10) || 1;
        const play = (fen, tokens) => {
            const b = new ChessCtor(fen);
            const out = [];
            for (const t of tokens) {
                let m = null;
                try { m = b.move(t.san.replace(/[!?]+$/, '')); } catch (e) { m = null; }
                if (!m) break;
                out.push(m.san);
            }
            return out;
        };
        const endFen = (fen, sans) => {
            const b = new ChessCtor(fen);
            sans.forEach(s => b.move(s));
            return b.fen();
        };
        // Game move reached at each step when a line from game position k follows the game
        const gameSteps = (k, sans) => {
            const out = [];
            for (let j = 0; j < sans.length; j++) {
                if (k === null || k + j >= game.length || bareSan(sans[j]) !== game[k + j]) break;
                out.push(k + j);
            }
            return out;
        };

        const re = new RegExp(MOVE_TOKEN, 'g');
        const runs = [];
        let match;
        while ((match = re.exec(src))) {
            const tok = {
                start: match.index,
                end: match.index + match[0].length,
                number: match[1] ? parseInt(match[1], 10) : null,
                black: match[2] ? match[2].replace(/\s/g, '') !== '.' : null,
                san: match[3]
            };
            const last = runs[runs.length - 1];
            if (last && /^\s*$/.test(src.slice(last.tokens[last.tokens.length - 1].end, tok.start))) last.tokens.push(tok);
            else runs.push({ tokens: [tok] });
        }

        const lines = []; // { startFen, sans, gameStart }
        const linked = [];
        let lastLine = -1; // the line the previous run started or extended
        runs.forEach(run => {
            const first = run.tokens[0];
            const fits = fen => first.number === null || (number(fen) === first.number && (side(fen) === 'b') === first.black);
            const candidates = [];
            const add = (fen, line, gameIndex) => { if (fen && fits(fen)) candidates.push({ fen, line, gameIndex }); };
            // A line going on ("1...e6 ... after 2.Nf3 d5"), then the game, then older lines
            if (lastLine >= 0) add(endFen(lines[lastLine].startFen, lines[lastLine].sans), lastLine, null);
            if (first.number === null) {
                if (index >= 0) { add(positions[index], -1, index); add(positions[index + 1], -1, index + 1); }
                else add(positions[0], -1, 0);
            }
            for (let k = positions.length - 1; k >= 0; k--) add(positions[k], -1, k);
            for (let k = lines.length - 1; k >= 0; k--) if (k !== lastLine) add(endFen(lines[k].startFen, lines[k].sans), k, null);

            let best = null;
            for (const c of candidates) {
                const sans = play(c.fen, run.tokens);
                if (sans.length && (!best || sans.length > best.sans.length)) best = Object.assign({ sans }, c);
                if (sans.length === run.tokens.length) break;
            }
            if (!best) return;
            const loneSquare = run.tokens.length === 1 && first.number === null && /^[a-h][1-8][+#]?[!?]*$/.test(first.san);
            if (loneSquare) {
                // "the pawn on e5", "a knight to d5": a square, not a move
                if (/\b(on|to|at|from|into|onto|of|the|via|towards?|square|squares|and|or)\s+$/i.test(src.slice(Math.max(0, first.start - 12), first.start))) return;
                if (!(best.gameIndex !== null && best.gameIndex !== undefined && gameSteps(best.gameIndex, best.sans).length)) return;
            }

            let lineId;
            let offset = 0;
            if (best.line >= 0) {
                lineId = best.line;
                offset = lines[lineId].sans.length;
                lines[lineId].sans = lines[lineId].sans.concat(best.sans);
            } else {
                lineId = lines.length;
                lines.push({ startFen: best.fen, sans: best.sans.slice(), gameStart: best.gameIndex });
            }
            lastLine = lineId;
            const steps = gameSteps(lines[lineId].gameStart === undefined ? null : lines[lineId].gameStart, lines[lineId].sans);
            best.sans.forEach((san, j) => {
                const step = offset + j;
                linked.push({ tok: run.tokens[j], line: lineId, step, gameIndex: step < steps.length ? steps[step] : null });
            });
        });

        const segments = [];
        let pos = 0;
        linked.sort((a, b) => a.tok.start - b.tok.start).forEach(l => {
            if (l.tok.start > pos) segments.push({ type: 'text', text: src.slice(pos, l.tok.start) });
            segments.push({ type: 'move', text: src.slice(l.tok.start, l.tok.end), line: l.line, step: l.step, gameIndex: l.gameIndex });
            pos = l.tok.end;
        });
        if (pos < src.length) segments.push({ type: 'text', text: src.slice(pos) });
        return { segments, lines: lines.map(l => ({ startFen: l.startFen, sans: l.sans })) };
    }

    /**
     * True when the "commentary" is really a content-safety classifier's
     * verdict, e.g. NVIDIA NemoGuard's "User Safety: safe / Response Safety:
     * safe" (a guard model picked as the model, or a guardrail on the endpoint
     * replacing the answer). Such text must not be shown or saved.
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

    function escapeHtml(text) {
        return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // Placeholders the caller puts in the text (e.g. for move buttons) pass through untouched.
    const PLACEHOLDER_OPEN = '';
    const PLACEHOLDER_CLOSE = '';

    /** Inline markdown on one line: `code`, **bold**, __bold__, *italic*, _italic_, ~~strike~~, [text](url) -> text. */
    function inlineMarkdown(line) {
        const codes = [];
        let t = String(line).replace(/`([^`]+)`/g, (m, code) => {
            codes.push(`<code>${escapeHtml(code)}</code>`);
            return `${codes.length - 1}`;
        });
        t = escapeHtml(t)
            .replace(/\[([^\]]+)\]\((?:[^)\s]+)\)/g, '$1')
            .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
            .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?=[^\w]|$)/g, '$1<strong>$2</strong>')
            .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?=[^\w*]|$)/g, '$1<em>$2</em>')
            .replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?=[^\w]|$)/g, '$1<em>$2</em>')
            .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
        return t.replace(/(\d+)/g, (m, i) => codes[Number(i)]);
    }

    // "1. e4", "12... Nxd5": move numbers, not a numbered list
    const MOVE_START = new RegExp(`^(?:\\.\\.|…)?\\s*${SAN_BODY}(?![\\w-])`);

    /**
     * The markdown models write, as safe HTML: paragraphs (single newlines kept as
     * <br>), # headings, - / * / + bullets, 1. / 1) numbered lists (but not move
     * numbers like "1. e4"), > quotes, --- rules, ``` code blocks and the inline
     * marks of inlineMarkdown(). Everything else is escaped text; links keep only
     * their text. Deterministic, no DOM.
     */
    function markdownToHtml(text) {
        const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
        const out = [];
        let para = [];
        let list = null; // { tag, items }
        let quote = [];
        const flushPara = () => { if (para.length) out.push(`<p>${para.map(inlineMarkdown).join('<br>')}</p>`); para = []; };
        const flushList = () => { if (list) out.push(`<${list.tag}>${list.items.map(i => `<li>${inlineMarkdown(i)}</li>`).join('')}</${list.tag}>`); list = null; };
        const flushQuote = () => { if (quote.length) out.push(`<blockquote>${markdownToHtml(quote.join('\n'))}</blockquote>`); quote = []; };
        const flushAll = () => { flushPara(); flushList(); flushQuote(); };
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (/^\s*```/.test(line)) {
                flushAll();
                const code = [];
                for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i]);
                out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
                continue;
            }
            if (/^\s*>/.test(line)) { flushPara(); flushList(); quote.push(line.replace(/^\s*>\s?/, '')); continue; }
            flushQuote();
            if (!line.trim()) { flushPara(); flushList(); continue; }
            const heading = line.match(/^\s*#{1,6}\s+(.*?)\s*#*\s*$/);
            if (heading) { flushAll(); out.push(`<p class="gc-md-heading">${inlineMarkdown(heading[1])}</p>`); continue; }
            if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flushAll(); out.push('<hr>'); continue; }
            const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
            const numbered = line.match(/^\s*(\d+)([.)])\s+(.*)$/);
            const isMoveNumber = numbered && numbered[2] === '.' && MOVE_START.test(numbered[3]);
            if (bullet || (numbered && !isMoveNumber)) {
                flushPara();
                const tag = bullet ? 'ul' : 'ol';
                if (list && list.tag !== tag) flushList();
                if (!list) list = { tag, items: [] };
                list.items.push(bullet ? bullet[1] : numbered[3]);
                continue;
            }
            // A line right under a list item, indented: part of that item
            if (list && /^\s{2,}\S/.test(line)) { list.items[list.items.length - 1] += ` ${line.trim()}`; continue; }
            flushList();
            para.push(line.trim());
        }
        flushAll();
        return out.join('');
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
        linkMoves,
        markdownToHtml,
        PLACEHOLDER_OPEN,
        PLACEHOLDER_CLOSE,
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
