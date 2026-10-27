/**
 * game-commentary.js - GothamChess-style game article for WhyBlunder.
 *
 * Once the engine has analyzed the game, an LLM writes one article about it,
 * like a GothamChess recap video turned into a blog post: a title, an intro,
 * sections that follow the story of the game, and the lessons to take away.
 * The request (buildArticleMessages) holds the game header, the moves, and
 * the engine notes of the key moments only (PgnExport.moveNotes): the moves
 * that decided the game, not a comment on every move.
 *
 * linkMoves() finds the moves the model wrote ("14... Qd7", "15. Qh5 g6")
 * and checks them with chess.js, so the UI can make them clickable.
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
        'You are a chess writer with the voice of Levy Rozman (GothamChess): punchy, funny and direct, talking straight to',
        'the reader, naming the tactics (fork, pin, skewer, discovered attack, back-rank mate...), hyping the great moves and',
        'roasting the blunders, always with the reason behind it.',
        '',
        'You write one article about a whole game, like a GothamChess recap video turned into a blog post. You get the moves',
        'of the game and a chess engine\'s notes on its key moments (verdict, comment, better lines, the punishment). Those',
        'notes are your private preparation. The reader never sees them, so do not read them out or refer to them: turn them',
        'into explanations.',
        '',
        'Tell the story of the game, do not walk through it move by move. Follow the game in order, spend your words on the',
        'moments that decided it, and cover the quiet stretches in a sentence or two. Teach, do not recap: the reader wants',
        'the why, what each side is aiming for, where the alternatives lead and the pattern to remember. Every sentence says',
        'something about the game: no filler, no warm-up, no questions to the reader.',
        '- Structure: a title on the first line ("# ..."), a short intro (the players, the opening and its main idea), then',
        '  sections with "## " headings that follow the game, named after what happens in them (not "Middlegame" but "The',
        '  knight that never came back"), and a last section "## Lessons" with 2 to 4 bullet points the reader can use in',
        '  their own games.',
        '- For an inaccuracy, mistake or blunder, say exactly what goes wrong (the hanging piece, the tactic it allows, the',
        '  weakness it creates) and play the punishing line out, saying what its key moves achieve ("3... Nf6?? and 4. Qxf7',
        '  is mate: f7 was only defended by the king").',
        '- For the better move and the other alternatives in the notes, explain the idea behind them and how play would go',
        '  on (the plan, the threat, the kind of position it leads to), not only their names.',
        '- For a great or brilliant move, say why it works and what goes wrong for the opponent after the natural replies.',
        '- When a player misses the punishment of the opponent\'s mistake, show what they missed and why it works.',
        '- Write every move with its number, in standard algebraic notation: "14. Nxe5", "14... Qd7", and number the',
        '  lines too ("15. Qh5 g6 16. Qxe5"). The reader can click moves written like that to see them on the board.',
        '- Never quote evaluation numbers (+1.35, -0.61, #3) and never say "the engine says", "the engine notes",',
        '  "according to the notes", "Stockfish evaluates", "the computer gives" or "the evaluation is". Give the reason, not',
        '  the verdict; when the overall picture matters, say it in a few plain words ("White is just winning", "Black is up',
        '  a piece").',
        '- Stay faithful to the notes and the moves: do not invent tactics, threats or lines they do not support, and only',
        '  mention moves that are legal in the position.',
        '- Answer with the article itself, in markdown: no preamble, no notes about these instructions, and no thinking out',
        '  loud.'
    ].join('\n');

    const CRITICAL = ['inaccuracy', 'mistake', 'miss', 'blunder', 'brilliant', 'great'];
    const FLAWED = ['inaccuracy', 'mistake', 'miss', 'blunder'];

    const STORAGE_KEY = 'whyblunder_commentary_v6'; // v6: one article per game (v3-v5: per move, v1/v2: one-shot sections)
    const OLD_STORAGE_KEYS = ['whyblunder_commentary_v1', 'whyblunder_commentary_v2', 'whyblunder_commentary_v3', 'whyblunder_commentary_v4', 'whyblunder_commentary_v5'];
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

    /** SAN as shown to the reader: check and mate signs kept, ?! annotations dropped. */
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

    /** First move of a punishment line ("4. Qxf7#" -> "Qxf7"). */
    function firstSan(line) {
        return bareSan(String(line || '').replace(/^\d+\.(\.\.)?\s*/, '').split(/\s+/)[0]);
    }

    /**
     * The moves worth an explanation: inaccuracies, mistakes, misses, blunders,
     * great and brilliant moves, plus the moves that punish the previous mistake
     * or miss its punishment. Each { index, key, notes, punishes, missedPunishment }.
     */
    function keyMoments(moves, P) {
        const list = moves || [];
        const notesOf = i => (P && P.moveNotes ? P.moveNotes(list, i) : null);
        const out = [];
        let prevNotes = null;
        list.forEach((move, index) => {
            const key = qualityKey(move);
            const prev = index > 0 ? list[index - 1] : null;
            const punishFirst = prev && FLAWED.includes(qualityKey(prev)) && prevNotes && prevNotes.punishment ? firstSan(prevNotes.punishment) : '';
            const punishes = Boolean(punishFirst && punishFirst === bareSan(move.move));
            const missedPunishment = Boolean(punishFirst && punishFirst !== bareSan(move.move));
            const critical = CRITICAL.includes(key) || punishes || missedPunishment;
            const notes = critical ? notesOf(index) : null; // the next move checks its punishment
            if (critical) out.push({ index, key, notes, punishes, missedPunishment, prevPunishment: prevNotes ? prevNotes.punishment : '' });
            prevNotes = notes;
        });
        return out;
    }

    /** Words to ask for: more key moments, a longer article, but a short game stays short. */
    function articleLength(momentCount, plies) {
        let words = 250 + 60 * momentCount;
        if (plies) words = Math.min(words, 300 + 25 * plies);
        return Math.max(300, Math.min(1000, Math.round(words / 50) * 50));
    }

    /** 'an inaccuracy', 'a mistake' */
    function withArticle(word) {
        return `${/^[aeiou]/i.test(word) ? 'an' : 'a'} ${word}`;
    }

    /**
     * Chat messages asking for the article about the whole game.
     *
     * @param {object} o
     *   moves     analyzed moves (output contract in AGENTS.md)
     *   gameInfo  { white, black, white_elo, black_elo, opening, eco, result, date, event }
     */
    function buildArticleMessages(o) {
        const moves = o.moves || [];
        const info = o.gameInfo || {};
        const P = getPgnExport(o.PgnExport);
        const last = moves.length - 1;
        const result = /^(1-0|0-1|1\/2-1\/2)$/.test(String(info.result || '').trim()) ? String(info.result).trim() : '';

        const task = [];
        const header = [players(info)];
        if (info.opening) header.push(`Opening: ${info.opening}${info.eco ? ` (${info.eco})` : ''}`);
        if (info.event && info.event !== '?') header.push(`Event: ${info.event}`);
        header.push(`Result: ${result || 'unknown'}`);
        task.push(`Game: ${header.join('. ')}.`);
        task.push('');
        task.push(`Moves: ${movesSoFar(moves, last)}${result ? ` ${result}` : ''}`);
        const final = last >= 0 && P && P.moveNotes ? P.moveNotes(moves, last) : null;
        if (final && final.fenAfter) task.push(`Final position (FEN): ${final.fenAfter}`);
        task.push('');

        const moments = keyMoments(moves, P);
        if (moments.length) {
            task.push('Engine notes on the key moments (private, do not read them out):');
            moments.forEach(k => {
                const move = moves[k.index];
                const label = moveLabel(moves, k.index);
                const notes = k.notes;
                task.push('');
                task.push(`${label} (${move.is_white ? 'White' : 'Black'}): ${(notes && notes.quality) || k.key || 'good move'}`);
                if (notes && notes.fenBefore) task.push(`- Position before the move (FEN): ${notes.fenBefore}`);
                if (notes && notes.comment) task.push(`- Comment: ${notes.comment}`);
                if (notes && notes.lines && notes.lines.length) task.push(`- Lines from the position before the move: ${notes.lines.join(' | ')}`);
                if (notes && notes.punishment) task.push(`- How the opponent can punish it: ${notes.punishment}`);
                if (k.punishes) task.push(`- It punishes the previous move, ${moveLabel(moves, k.index - 1)} (${withArticle(qualityKey(moves[k.index - 1]))}).`);
                if (k.missedPunishment) task.push(`- The previous move, ${moveLabel(moves, k.index - 1)}, was ${withArticle(qualityKey(moves[k.index - 1]))}: it could have been punished with ${k.prevPunishment}, and ${label} misses that.`);
            });
            task.push('');
            task.push('Cover every key moment, in the order of the game: the ones that decided the game at length (the line that shows it,');
            task.push('the better move and how play would go on), the small slips in a sentence.');
        } else {
            task.push('The engine found no mistakes and no standout moves: tell the story of the plans and how the game was decided.');
        }
        task.push(`Write about ${articleLength(moments.length, moves.length)} words. Answer with the article only.`);

        return [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: task.join('\n') }
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
     * Find the chess moves in a text and check them on the board.
     * Moves written next to each other ("2.Nf3 d5 3.exd5") form a run; a run
     * starts from the end of an earlier run in the text (a line going on), or
     * from a position of the game whose move number and side match ("1...e6" =
     * an alternative to Black's first move). Without `index` (an article about
     * the whole game) bare moves ("Qxf7#") are tried around the last game move
     * the text named, after it then before it; with `index` (a text about the
     * move on screen) before and after that move. A lone pawn move that reads
     * like a square ("e5") is only linked when it is a move of the game and
     * not a square ("on e5"). Unchecked text stays text.
     *
     * @param {string} text
     * @param {object} o  { moves: game moves (SAN strings or move objects), index: optional move on screen (-1 = start) }
     * @returns {{ segments: Array, lines: Array }}
     *   segments: { type: 'text', text } | { type: 'move', text, line, step, gameIndex }
     *     (gameIndex: the game move this is, when the line follows the game; else null)
     *   lines: { startFen, sans, gameStart } (line = index in lines, step = index in sans;
     *     gameStart: the game move the line starts before, so it starts after move gameStart - 1)
     */
    function linkMoves(text, o) {
        const opts = o || {};
        const src = String(text || '');
        const ChessCtor = getChessConstructor(opts.Chess);
        const plain = { segments: src ? [{ type: 'text', text: src }] : [], lines: [] };
        if (!ChessCtor || !src) return plain;
        const game = (opts.moves || []).map(m => bareSan(typeof m === 'string' ? m : (m && m.move)));
        const whole = typeof opts.index !== 'number';
        const index = whole ? game.length - 1 : opts.index;

        // positions[k] = before game move k, up to the position after the move on screen (or the end)
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
        // Every run is tried from many positions: the legal moves of a position and the position
        // after a move are worked out once (an article names dozens of moves of a long game)
        const sanKey = san => String(san).replace(/[+#!?=]/g, '');
        const legal = new Map(); // fen -> Map(sanKey -> SAN)
        const after = new Map(); // fen + SAN -> fen
        const legalMoves = fen => {
            if (!legal.has(fen)) {
                let list = [];
                try { list = new ChessCtor(fen).moves(); } catch (e) { list = []; }
                legal.set(fen, new Map(list.map(san => [sanKey(san), san])));
            }
            return legal.get(fen);
        };
        const next = (fen, san) => {
            const k = `${fen}|${san}`;
            if (!after.has(k)) {
                const b = new ChessCtor(fen);
                b.move(san);
                after.set(k, b.fen());
            }
            return after.get(k);
        };
        const play = (fen, tokens) => {
            const out = [];
            let at = fen;
            for (const t of tokens) {
                const san = legalMoves(at).get(sanKey(t.san));
                if (!san) break;
                out.push(san);
                at = next(at, san);
            }
            return { sans: out, end: at };
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

        const lines = []; // { startFen, sans, gameStart, end: the position after the line }
        const linked = [];
        let lastLine = -1; // the line the previous run started or extended
        let context = 0;   // whole game: the position after the last game move named
        runs.forEach(run => {
            const first = run.tokens[0];
            const fits = fen => first.number === null || (number(fen) === first.number && (side(fen) === 'b') === first.black);
            const candidates = [];
            const add = (fen, line, gameIndex) => { if (fen && fits(fen)) candidates.push({ fen, line, gameIndex }); };
            // A line going on ("1...e6 ... after 2.Nf3 d5"), then the game, then older lines
            if (lastLine >= 0) add(lines[lastLine].end, lastLine, null);
            if (first.number === null) {
                if (whole) { add(positions[context], -1, context); add(positions[context - 1], -1, context - 1); }
                else if (index >= 0) { add(positions[index], -1, index); add(positions[index + 1], -1, index + 1); }
                else add(positions[0], -1, 0);
            }
            const order = positions.map((fen, k) => k).reverse();
            if (whole) order.sort((a, b) => Math.abs(a - context) - Math.abs(b - context) || b - a);
            order.forEach(k => add(positions[k], -1, k));
            for (let k = lines.length - 1; k >= 0; k--) if (k !== lastLine) add(lines[k].end, k, null);

            let best = null;
            for (const c of candidates) {
                const played = play(c.fen, run.tokens);
                if (played.sans.length && (!best || played.sans.length > best.sans.length)) best = Object.assign({}, c, played);
                if (played.sans.length === run.tokens.length) break;
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
                lines[lineId].end = best.end;
            } else {
                lineId = lines.length;
                lines.push({ startFen: best.fen, sans: best.sans.slice(), gameStart: best.gameIndex, end: best.end });
            }
            lastLine = lineId;
            const steps = gameSteps(lines[lineId].gameStart === undefined ? null : lines[lineId].gameStart, lines[lineId].sans);
            best.sans.forEach((san, j) => {
                const step = offset + j;
                const gameIndex = step < steps.length ? steps[step] : null;
                linked.push({ tok: run.tokens[j], line: lineId, step, gameIndex });
                if (gameIndex !== null) context = gameIndex + 1;
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
        return { segments, lines: lines.map(l => ({ startFen: l.startFen, sans: l.sans, gameStart: l.gameStart === undefined ? null : l.gameStart })) };
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
     * one is still open), no "Here's the article:" preamble, no ```markdown
     * fence around it, trimmed. With `partial` (text still streaming), an
     * opening fence still being written is held back.
     */
    function cleanText(text, partial) {
        let t = String(text || '').replace(/\r\n?/g, '\n');
        t = t.replace(/<think>[\s\S]*?<\/think>/gi, '');
        const open = t.search(/<think>/i);
        if (open >= 0) t = t.slice(0, open);
        t = t.replace(/^\s+/, '');
        t = t.replace(/^(?:sure|okay|ok|alright|here(?:'s| is))\b[^\n]{0,80}:[ \t]*\n/i, '');
        t = t.replace(/^\s*```(?:markdown|md)?[ \t]*\n/i, '').replace(/\n```\s*$/, '');
        if (partial && /^\s*`{1,3}[a-z]*$/i.test(t)) return '';
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
            const heading = line.match(/^\s*(#{1,6})\s+(.*?)\s*#*\s*$/);
            if (heading) { flushAll(); out.push(`<p class="gc-md-heading gc-md-h${heading[1].length}">${inlineMarkdown(heading[2])}</p>`); continue; }
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

    /** Saved article of a game: { text, model, savedAt } or null. */
    function loadArticle(key, storage) {
        const entry = readAll(storage)[key];
        return entry && typeof entry.text === 'string' && entry.text ? entry : null;
    }

    /** Save the article of a game, keeping the MAX_STORED most recent games. */
    function saveArticle(key, text, model, storage) {
        if (!key) return false;
        const data = readAll(storage);
        data[key] = { text: String(text || ''), model: model || '', savedAt: Date.now() };
        return writeAll(data, storage);
    }

    function removeArticle(key, storage) {
        const data = readAll(storage);
        if (!data[key]) return;
        delete data[key];
        writeAll(data, storage);
    }

    return {
        SYSTEM_PROMPT,
        STORAGE_KEY,
        SETTINGS_KEY,
        DEFAULT_BASE_URL,
        buildArticleMessages,
        keyMoments,
        articleLength,
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
        loadArticle,
        saveArticle,
        removeArticle
    };
}));
