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
        'You write one article about one game, like a GothamChess recap video turned into a blog post. You get the game as an',
        'annotated move list, split into chapters: every move in the order it was played, with the side that played it and',
        'how good it was, and under the key moments what the move does, the better move and the punishment. Everything you',
        'write comes from that move list. The reader follows the article on a board, one move after the other.',
        '',
        'How to write it:',
        '- Start with a title ("# ..."), then a short intro: the players and the opening. Do not give away anything that',
        '  happens later in the game.',
        '- Then one section per chapter, in order, each starting with the heading given for it, word for word. A section only',
        '  talks about the moves of its chapter, in the order they were played.',
        '- Cover the quiet moves of a chapter in a sentence or two (the plans, what each side is building). Spend your words',
        '  on the key moments, and teach: why the move works or fails, what each side is aiming for, the pattern to remember.',
        '- At a key moment, first say what was played and by whom ("Black played 14... Qd7"), then why it is good or bad (the',
        '  hanging piece, the tactic, the weakness), then the better move or the punishment as something that did not happen',
        '  ("Instead, 14... Nf6 would have..."), then go back to the game ("In the game, White replied 15. Qh5").',
        '- Get the sides right: "14. Nf3" (one dot) is White\'s move, "14... Nf6" (three dots) is Black\'s. Name the side',
        '  every time you bring up a move.',
        '- Write every move with its number ("14. Nxe5", "14... Qd7", lines too: "15. Qh5 g6 16. Qxe5"); the reader can click',
        '  them. Only use moves from the move list: the moves played, and the better moves and punishments given there.',
        '- After the last chapter, say how the game ended, then a "## Lessons" section with 2 to 4 bullet points the reader',
        '  can use in their own games, each tied to a moment of this game.',
        '- Never write numbers that measure the position (+1.35, -0.61, #3, "an advantage of 2.1"), and never mention an',
        '  engine, a computer, an evaluation, notes, the move list or a FEN. Say it in plain words: "White is just winning",',
        '  "Black is up a piece".',
        '- Do not invent tactics, threats, squares or pieces that the move list does not support.',
        '- Answer with the article itself, in markdown: no preamble, no notes about these instructions, and no thinking out',
        '  loud.'
    ].join('\n');

    const CRITICAL = ['inaccuracy', 'mistake', 'miss', 'blunder', 'brilliant', 'great'];
    const FLAWED = ['inaccuracy', 'mistake', 'miss', 'blunder'];

    const STORAGE_KEY = 'whyblunder_commentary_v8'; // v8: from an annotated move list (v7: chapters, v6: free-form article, v3-v5: per move, v1/v2: one-shot sections)
    const OLD_STORAGE_KEYS = ['whyblunder_commentary_v1', 'whyblunder_commentary_v2', 'whyblunder_commentary_v3', 'whyblunder_commentary_v4', 'whyblunder_commentary_v5', 'whyblunder_commentary_v6', 'whyblunder_commentary_v7'];
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

    function getPhaseOf(override) {
        if (override) return override;
        const E = typeof ChessEvaluator !== 'undefined' ? ChessEvaluator
            : (typeof window !== 'undefined' && window.ChessEvaluator) ? window.ChessEvaluator : null;
        if (E && E.gamePhase) return E.gamePhase;
        try {
            return require('./chess-evaluator.js').gamePhase || null;
        } catch (e) {
            return null;
        }
    }

    const PHASES = ['opening', 'middlegame', 'endgame'];
    const PHASE_LABELS = { opening: 'Opening', middlegame: 'Middlegame', endgame: 'Endgame' };
    const MAX_CLUSTERS = 3; // key moments (a move and the reply that punishes it count once) per chapter
    const MIN_CHAPTER = 4;  // plies: a shorter phase joins its neighbour

    /**
     * The game in chapters, in the order it was played: the phases (opening,
     * middlegame, endgame from the position before each move, never going back),
     * a phase shorter than MIN_CHAPTER plies joined to its neighbour, and a phase
     * with more than MAX_CLUSTERS key moments cut after every third one (a piece
     * left shorter than MIN_CHAPTER joins the chapter before it), so each
     * section of the article tells a short stretch of the game.
     *
     * @returns {Array<{ phase, label, start, end, moments: number[] }>} ply indices, inclusive
     */
    function gameChapters(moves, o) {
        const list = moves || [];
        const opts = o || {};
        if (!list.length) return [];
        const phaseOf = getPhaseOf(opts.phaseOf);
        const ChessCtor = getChessConstructor(opts.Chess);
        // Phase of the position before each move
        const phases = [];
        let floor = 0;
        let board = null;
        try { board = ChessCtor ? new ChessCtor() : null; } catch (e) { board = null; }
        list.forEach(m => {
            let p = 'middlegame';
            if (phaseOf && board) {
                try { p = phaseOf(board.fen()) || 'middlegame'; } catch (e) { p = 'middlegame'; }
            }
            floor = Math.max(floor, Math.max(0, PHASES.indexOf(p)));
            phases.push(PHASES[floor]);
            if (board) {
                let done = null;
                try { done = board.move(bareSan(m.move)) || board.move(m.move); } catch (e) { done = null; }
                if (!done) board = null;
            }
        });
        let ranges = [];
        phases.forEach((phase, i) => {
            const last = ranges[ranges.length - 1];
            if (last && last.phase === phase) last.end = i;
            else ranges.push({ phase, start: i, end: i });
        });
        // A short phase joins the one before it (the first one joins the next)
        const merged = [];
        ranges.forEach((r, i) => {
            const short = r.end - r.start + 1 < MIN_CHAPTER;
            if (short && merged.length) merged[merged.length - 1].end = r.end;
            else if (short && i + 1 < ranges.length) ranges[i + 1].start = r.start;
            else merged.push(Object.assign({}, r));
        });
        ranges = merged;

        const momentSet = new Set((opts.moments || []).map(k => (typeof k === 'number' ? k : k.index)));
        const chapters = [];
        ranges.forEach(r => {
            let start = r.start;
            let clusters = 0;
            for (let i = r.start; i <= r.end; i++) {
                if (!momentSet.has(i)) continue;
                if (momentSet.has(i - 1) && i - 1 >= start) continue; // a reply to a key moment stays with it
                clusters++;
                if (clusters > MAX_CLUSTERS && i - start >= MIN_CHAPTER) {
                    chapters.push({ phase: r.phase, start, end: i - 1 });
                    start = i;
                    clusters = 1;
                }
            }
            chapters.push({ phase: r.phase, start, end: r.end });
        });
        // A stretch left too short by a cut joins the chapter before it
        for (let n = chapters.length - 1; n > 0; n--) {
            if (chapters[n].end - chapters[n].start + 1 < MIN_CHAPTER) {
                chapters[n - 1].end = chapters[n].end;
                chapters.splice(n, 1);
            }
        }
        return chapters.map(c => {
            const moments = [];
            for (let i = c.start; i <= c.end; i++) if (momentSet.has(i)) moments.push(i);
            return Object.assign(c, { label: PHASE_LABELS[c.phase], moments });
        });
    }

    /** 'moves 12-20' (the move numbers of a chapter). */
    function chapterRange(moves, c) {
        const a = moves[c.start].move_number;
        const b = moves[c.end].move_number;
        return a === b ? `move ${a}` : `moves ${a}-${b}`;
    }

    // How each move is rated in the move list sent to the model
    const VERDICTS = {
        brilliant: 'BRILLIANT (!!)', great: 'GREAT MOVE (!)', best: 'best move', excellent: 'excellent', good: 'good',
        'good move': 'good', book: 'book move', inaccuracy: 'INACCURACY (?!)', mistake: 'MISTAKE (?)', miss: 'MISSED WIN (?)',
        blunder: 'BLUNDER (??)'
    };
    const NOTE_MAX_PLIES = 6;

    /**
     * An analysis comment in plain words, with nothing the model could read out
     * as a number: no [%eval] tags or {comments}, no evaluations in brackets,
     * no sentence that still measures the position or names the engine, and no
     * leading verdict (the move list gives it).
     */
    function plainNote(text) {
        const t = String(text || '')
            .replace(/\{[^}]*\}/g, ' ')
            .replace(/\[%[^\]]*\]/g, ' ')
            .replace(/\s*\(\s*(?:[+-]?\d+\.\d+|[+-]?#-?\d+|[+-]?M-?\d+)\s*\)/g, '')
            .replace(/(^|\s)[+-]?\d+\.\d+\b/g, '$1\u0000')
            .replace(/\s+/g, ' ')
            .trim()
            .replace(/^(?:Brilliant|Great move|Best move|Excellent|Good move|Book move|Inaccuracy|Mistake|Missed win|Blunder)[.!]?\s*/i, '');
        return t.split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
            .filter(s => s && !/\u0000|\bevaluation\b|\bengine\b|stockfish/i.test(s))
            .join(' ');
    }

    /** A line ('3... g6 { Better } 4. Qf3 Nf6 5. d3 ...') cut to its first plies, without comments. */
    function shortLine(line, maxPlies) {
        const tokens = String(line || '').replace(/\{[^}]*\}/g, ' ').replace(/\[%[^\]]*\]/g, ' ').trim().split(/\s+/).filter(Boolean);
        const out = [];
        let plies = 0;
        let white = null; // number of the White move just written
        for (const tok of tokens) {
            const num = tok.match(/^(\d+)\.(\.\.)?$/);
            // "4. d4 4... exd4" (the number a removed comment left behind) -> "4. d4 exd4"
            if (num && num[2] && white === num[1] && out.length && !/^\d+\./.test(out[out.length - 1])) continue;
            if (num) { white = num[2] ? null : num[1]; out.push(tok); continue; }
            if (++plies > (maxPlies || NOTE_MAX_PLIES)) break;
            out.push(tok);
        }
        while (out.length && /^\d+\.(?:\.\.)?$/.test(out[out.length - 1])) out.pop();
        return out.join(' ');
    }

    const PIECE_NAMES = { q: ['queen', 'queens'], r: ['rook', 'rooks'], b: ['bishop', 'bishops'], n: ['knight', 'knights'], p: ['pawn', 'pawns'] };

    /** 'queen, 2 rooks, bishop and 5 pawns' for one side of a FEN ('w' | 'b'). */
    function materialOf(fen, color) {
        const board = String(fen || '').split(' ')[0];
        const parts = ['q', 'r', 'b', 'n', 'p'].map(t => {
            const n = (board.match(new RegExp(color === 'w' ? t.toUpperCase() : t, 'g')) || []).length;
            return n ? (n === 1 ? PIECE_NAMES[t][0] : `${n} ${PIECE_NAMES[t][1]}`) : '';
        }).filter(Boolean);
        if (!parts.length) return 'only the king';
        return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
    }

    /** How the game finished, from the last move, the final position and the result. */
    function gameEnding(moves, result, fenAfter, ChessCtor) {
        const last = moves.length - 1;
        if (last < 0) return '';
        const label = moveLabel(moves, last);
        const mover = moves[last].is_white ? 'White' : 'Black';
        let board = null;
        try { board = fenAfter && ChessCtor ? new ChessCtor(fenAfter) : null; } catch (e) { board = null; }
        let how;
        if (/#$/.test(String(moves[last].move)) || (board && board.in_checkmate && board.in_checkmate())) how = `${mover} delivered checkmate with ${label}.`;
        else if (board && board.in_stalemate && board.in_stalemate()) how = `Stalemate after ${label}: a draw.`;
        else if (result === '1-0') how = `Black resigned (or ran out of time) after ${label}.`;
        else if (result === '0-1') how = `White resigned (or ran out of time) after ${label}.`;
        else if (result === '1/2-1/2') how = `The game was drawn after ${label}.`;
        else how = `The game stopped after ${label}.`;
        const material = fenAfter ? ` Material at the end: White has ${materialOf(fenAfter, 'w')}; Black has ${materialOf(fenAfter, 'b')}.` : '';
        return how + material;
    }

    /** '## The opening (moves 1-5)', '## The middlegame, part 2 (moves 21-28)' */
    function chapterHeading(moves, chapters, n) {
        const c = chapters[n];
        const same = chapters.filter(x => x.phase === c.phase);
        const part = same.length > 1 ? `, part ${same.indexOf(c) + 1}` : '';
        return `## The ${c.label.toLowerCase()}${part} (${chapterRange(moves, c)})`;
    }

    /**
     * Chat messages asking for the article about the whole game. The game goes
     * in as an annotated move list, chapter by chapter: every move with its
     * side and verdict, and under each key moment what it does, the better
     * line and the punishment, in plain words (no numbers, no FEN).
     *
     * @param {object} o
     *   moves     analyzed moves (output contract in AGENTS.md)
     *   gameInfo  { white, black, white_elo, black_elo, opening, eco, result, date, event }
     *   phaseOf   optional fen -> 'opening'|'middlegame'|'endgame' (default ChessEvaluator.gamePhase)
     */
    function buildArticleMessages(o) {
        const moves = o.moves || [];
        const info = o.gameInfo || {};
        const P = getPgnExport(o.PgnExport);
        const ChessCtor = getChessConstructor(o.Chess);
        const last = moves.length - 1;
        const result = /^(1-0|0-1|1\/2-1\/2)$/.test(String(info.result || '').trim()) ? String(info.result).trim() : '';

        const task = [];
        const header = [players(info)];
        if (info.opening) header.push(`Opening: ${info.opening}${info.eco ? ` (${info.eco})` : ''}`);
        if (info.event && info.event !== '?') header.push(`Event: ${info.event}`);
        header.push(`Result: ${result || 'unknown'}`);
        task.push(`Game: ${header.join('. ')}.`);
        task.push('');

        const moments = keyMoments(moves, P);
        const chapters = gameChapters(moves, { moments, phaseOf: o.phaseOf, Chess: o.Chess });
        const byIndex = {};
        moments.forEach(k => { byIndex[k.index] = k; });
        task.push(`The game as an annotated move list, in ${chapters.length} chapter${chapters.length === 1 ? '' : 's'}. Write one section per chapter, in this order, under these headings:`);
        chapters.forEach((c, n) => {
            task.push('');
            task.push(chapterHeading(moves, chapters, n));
            for (let i = c.start; i <= c.end; i++) {
                const move = moves[i];
                const k = byIndex[i];
                const key = qualityKey(move);
                const side = move.is_white ? 'White' : 'Black';
                const verdict = VERDICTS[key] || 'good';
                task.push(`${moveLabel(moves, i)} (${side}): ${verdict}${k ? ' - KEY MOMENT' : ''}`);
                if (!k) continue;
                const notes = k.notes || {};
                const what = plainNote(notes.comment);
                if (what) task.push(`    What it does: ${what}`);
                (notes.lines || []).slice(0, 2).forEach(l => {
                    const line = shortLine(l);
                    if (line) task.push(`    ${FLAWED.includes(key) ? 'Better' : 'Also possible'}: ${line} (not played)`);
                });
                if (notes.punishment && FLAWED.includes(key)) {
                    const next = moves[i + 1];
                    const played = next && firstSan(notes.punishment) === bareSan(next.move);
                    task.push(`    The punishment: ${shortLine(notes.punishment)}${played ? ' (played in the game)' : ' (not played)'}`);
                }
                if (k.punishes) task.push(`    It punishes ${moveLabel(moves, i - 1)}, ${withArticle(qualityKey(moves[i - 1]))} by ${moves[i - 1].is_white ? 'White' : 'Black'}.`);
                if (k.missedPunishment) task.push(`    It misses the punishment of ${moveLabel(moves, i - 1)}: ${shortLine(k.prevPunishment)} (not played).`);
            }
        });
        const final = last >= 0 && P && P.moveNotes ? P.moveNotes(moves, last) : null;
        const ending = gameEnding(moves, result, final && final.fenAfter, ChessCtor);
        if (ending) {
            task.push('');
            task.push(`How it ended: ${ending}`);
        }
        task.push('');
        task.push(moments.length
            ? 'Cover every key moment where it happens: the ones that decided the game at length, the small slips in a sentence.'
            : 'There are no mistakes and no standout moves: tell the story of the plans, chapter by chapter, and how the game was decided.');
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

    // Reasoning some models write into the answer itself, not in a reasoning field
    const THINK_TAGS = ['think', 'thinking', 'reasoning', 'reflection'];
    const HARMONY_FINAL = '<|channel|>final<|message|>'; // gpt-oss: the answer after the "analysis" channel
    // Planning out loud: "We need to write...", "The user wants...", "Let's parse the moves"
    const REASONING_START = /^(?:we (?:need|must|have|should) to|we must\b|we need\b|the user (?:wants|asks|is asking)|let(?:'s| us| me)\b|i (?:need|have|should|will|'ll) (?:to )?(?:write|start|produce|craft|figure)|okay,? (?:so|let|the|we|i)\b|alright,? (?:so|let|the|we|i)\b|first,? (?:i|we|let)\b|so,? (?:the|we|i)\b)/i;

    /** True when the text reads like a model planning its answer rather than the answer. */
    function looksLikeReasoning(text) {
        return REASONING_START.test(String(text || '').trim());
    }

    /**
     * The model's answer, ready to show: no reasoning (<think>/<thinking>/
     * <reasoning> blocks, Kimi's ◁think▷, gpt-oss "analysis" channels with or
     * without their special tokens, and nothing while one is still open), no
     * "Here's the article:" preamble, no ```markdown fence around it, trimmed.
     * The article starts with its "# " title, so anything written before the
     * last title line is reasoning too. With `partial` (text still streaming),
     * text that still reads like reasoning, or an opening fence still being
     * written, is held back.
     */
    function cleanText(text, partial) {
        let t = String(text || '').replace(/\r\n?/g, '\n');
        // gpt-oss (Harmony): keep the final channel; an analysis channel alone is still thinking
        const fin = t.lastIndexOf(HARMONY_FINAL);
        if (fin >= 0) t = t.slice(fin + HARMONY_FINAL.length);
        else if (/<\|channel\|>/.test(t)) t = '';
        t = t.replace(/<\|[a-z_]+\|>/gi, '');
        // The same with the special tokens stripped: "analysis We need to... assistantfinal# Title"
        const harmony = t.match(/^\s*analysis\s*/i);
        if (harmony) {
            const finals = [...t.matchAll(/assistant\s*final/gi)];
            const rest = t.slice(harmony[0].length);
            if (finals.length) t = t.slice(finals[finals.length - 1].index + finals[finals.length - 1][0].length);
            else if (looksLikeReasoning(rest)) t = partial ? '' : rest;
        }
        THINK_TAGS.forEach(tag => {
            t = t.replace(new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`, 'gi'), '');
            const open = t.search(new RegExp(`<${tag}>`, 'i'));
            if (open >= 0) t = t.slice(0, open);
        });
        t = t.replace(/\u25c1think\u25b7[\s\S]*?\u25c1\/think\u25b7/g, '');
        const kimi = t.indexOf('\u25c1think\u25b7');
        if (kimi >= 0) t = t.slice(0, kimi);
        t = t.replace(/^\s+/, '');
        t = t.replace(/^(?:sure|okay|ok|alright|here(?:'s| is))\b[^\n]{0,80}:[ \t]*\n/i, '');
        t = t.replace(/^\s*```(?:markdown|md)?[ \t]*\n/i, '').replace(/\n```\s*$/, '');
        // Whatever comes before the article's title is the model thinking out loud
        if (!/^#[ \t]/.test(t)) {
            const titles = [...t.matchAll(/^#[ \t]+\S.*$/gm)];
            if (titles.length) t = t.slice(titles[titles.length - 1].index);
            else if (partial && looksLikeReasoning(t)) return '';
            t = t.replace(/\n```\s*$/, '');
        }
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
        gameChapters,
        plainNote,
        shortLine,
        gameEnding,
        articleLength,
        cleanText,
        looksLikeReasoning,
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
