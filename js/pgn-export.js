/**
 * pgn-export.js - Annotated PGN export for WhyBlunder.
 *
 * Turns an analyzed game (the BrowserWhyBlunder / MoveDiagnostics move
 * contract) into a PGN that other tools (Lichess studies, ChessBase, SCID...)
 * can import:
 *
 *   - [%eval] tags after every move (White POV, `#n` for mates),
 *   - NAGs for the classification ($3 !!, $1 !, $6 ?!, $2 ?, $4 ??),
 *   - a comment with the verdict, the best move and the "why" text,
 *   - engine lines as variations: the alternatives the engine weighed
 *     (why.alternatives, falling back to principal_variation) and the
 *     punishment line when the opponent did not find it,
 *   - extra lines (the player's explored lines) and per-move notes
 *     (the player's self review), both supplied by the caller.
 *
 * Pure and deterministic: no DOM, no engine, no randomness.
 */
(function(root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.PgnExport = factory();
    }
}(typeof self !== 'undefined' ? self : this, function() {
    'use strict';

    const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const LINE_WIDTH = 80;
    const DEFAULT_MAX_PLIES = 10;
    const RESULTS = ['1-0', '0-1', '1/2-1/2', '*'];

    const QUALITY_LABELS = {
        brilliant: 'Brilliant', great: 'Great move', best: 'Best move', excellent: 'Excellent',
        good: 'Good move', book: 'Book move', inaccuracy: 'Inaccuracy', mistake: 'Mistake',
        miss: 'Missed win', blunder: 'Blunder'
    };
    const QUALITY_NAGS = { brilliant: '$3', great: '$1', inaccuracy: '$6', mistake: '$2', miss: '$2', blunder: '$4' };
    const FLAGGED = ['inaccuracy', 'mistake', 'miss', 'blunder'];

    function getChessConstructor(override) {
        if (override) return override;
        if (typeof Chess !== 'undefined') return Chess;
        if (typeof window !== 'undefined' && window.Chess) return window.Chess;
        if (typeof global !== 'undefined' && global.Chess) return global.Chess;
        try {
            const c = require('./chess.min.js');
            return c.Chess || c;
        } catch (e) {
            return null;
        }
    }

    /** 'missed win' / 'good move' / 'blunder' ... -> one of QUALITY_LABELS keys ('' if unknown). */
    function qualityKey(move) {
        if (!move) return '';
        const q = String(move.detailed_quality || move.quality || '').toLowerCase().trim();
        if (q === 'missed win' || q === 'missed-win') return 'miss';
        if (q === 'good move' || q === 'good-move') return 'good';
        return QUALITY_LABELS[q] ? q : '';
    }

    function isFlagged(move) {
        return FLAGGED.includes(qualityKey(move));
    }

    /** '+1.20' -> '1.20', 'M3' -> '#3', '-M3' -> '#-3'. Null when unparseable. */
    function evalTag(text) {
        if (text === null || text === undefined) return null;
        const s = String(text).trim().replace(/^#/, 'M');
        const mate = s.match(/^([+-]?)M(\d+)$/i);
        if (mate) return `#${mate[1] === '-' ? '-' : ''}${mate[2]}`;
        const num = parseFloat(s);
        if (!isFinite(num)) return null;
        return num.toFixed(2);
    }

    /** Text safe inside a PGN { comment }: no braces, no markup, single-spaced. */
    function cleanComment(text) {
        if (text === null || text === undefined) return '';
        return String(text)
            .replace(/<[^>]*>/g, '')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/\{/g, '(')
            .replace(/\}/g, ')')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function headerValue(v) {
        return String(v === null || v === undefined ? '' : v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ');
    }

    function sameFen(a, b) {
        if (!a || !b) return false;
        return a.split(' ').slice(0, 4).join(' ') === b.split(' ').slice(0, 4).join(' ');
    }

    function bareSan(san) {
        return String(san || '').replace(/[?!+#]+$/g, '');
    }

    function moveToken(fen, san, forceNumber) {
        const parts = fen.split(' ');
        const num = parseInt(parts[5], 10) || 1;
        if (parts[1] === 'w') return `${num}. ${san}`;
        return forceNumber ? `${num}... ${san}` : san;
    }

    /** Play UCI moves from fen. Returns [{ san, fenBefore }]. Stops at the first illegal move. */
    function playUci(ChessCtor, fen, pv, maxPlies) {
        const out = [];
        if (!Array.isArray(pv)) return out;
        const board = new ChessCtor(fen);
        for (let i = 0; i < Math.min(maxPlies, pv.length); i++) {
            const uci = pv[i];
            if (!uci || typeof uci !== 'string' || uci.length < 4) break;
            const fenBefore = board.fen();
            let m = null;
            try {
                m = board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.length > 4 ? uci[4] : undefined });
            } catch (e) { m = null; }
            if (!m) break;
            out.push({ san: m.san, fenBefore });
        }
        return out;
    }

    /** Play SAN moves ('12. Be3 O-O 13. d4' or an array) from fen. Returns [{ san, fenBefore }]. */
    function playSan(ChessCtor, fen, sans, maxPlies) {
        const out = [];
        const tokens = Array.isArray(sans) ? sans : String(sans || '').split(/\s+/);
        const board = new ChessCtor(fen);
        for (let i = 0; i < tokens.length && out.length < maxPlies; i++) {
            let tok = String(tokens[i] || '').trim();
            if (!tok) continue;
            tok = tok.replace(/^\d+\.(\.\.)?/, '').replace(/[?!]+$/g, '');
            if (!tok || /^\d+\.*$/.test(tok) || tok === '...') continue;
            const fenBefore = board.fen();
            let m = null;
            try { m = board.move(tok); } catch (e) { m = null; }
            if (!m) {
                try { m = board.move(bareSan(tok)); } catch (e) { m = null; }
            }
            if (!m && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(tok)) {
                try { m = board.move({ from: tok.slice(0, 2), to: tok.slice(2, 4), promotion: tok[4] }); } catch (e) { m = null; }
            }
            if (!m) break;
            out.push({ san: m.san, fenBefore });
        }
        return out;
    }

    /**
     * Render a line as PGN tokens. `firstComment` goes after the first move.
     * Returns [] for an empty line.
     */
    function lineTokens(line, firstComment) {
        const tokens = [];
        line.forEach((step, i) => {
            const afterComment = i === 1 && firstComment;
            tokens.push(moveToken(step.fenBefore, step.san, i === 0 || afterComment));
            if (i === 0 && firstComment) tokens.push(`{ ${firstComment} }`);
        });
        return tokens;
    }

    function variationTokens(line, firstComment) {
        const inner = lineTokens(line, firstComment);
        if (!inner.length) return [];
        return ['('].concat(inner, [')']);
    }

    /** Engine lines for the position before moves[index] (alternatives to the move played). */
    function engineVariations(ChessCtor, move, fenBefore, opts) {
        const out = [];
        const analysis = move.analysis || {};
        const why = analysis.why;
        const flagged = isFlagged(move);
        const playedSan = bareSan(move.move);
        const seen = new Set([playedSan]);

        const alternatives = (why && Array.isArray(why.alternatives)) ? why.alternatives : [];
        alternatives.forEach((alt, i) => {
            if (!alt) return;
            // For a flagged move keep the lines that beat it (always at least the first one)
            if (opts.lines !== 'all' && i > 0 && alt.verdict !== 'better') return;
            const line = playUci(ChessCtor, fenBefore, alt.pv, opts.maxPlies);
            if (!line.length && alt.san) line.push(...playSan(ChessCtor, fenBefore, [alt.san], 1));
            if (!line.length || seen.has(bareSan(line[0].san))) return;
            seen.add(bareSan(line[0].san));
            const ev = evalTag(alt.evaluation);
            const label = alt.verdict ? `${alt.verdict.charAt(0).toUpperCase()}${alt.verdict.slice(1)}` : '';
            const text = cleanComment([label, alt.reason].filter(Boolean).join(': '));
            const comment = [ev ? `[%eval ${ev}]` : '', text].filter(Boolean).join(' ');
            out.push(variationTokens(line, comment));
        });

        // Older cache entries have no why: fall back to the formatted best line, then the best move
        const fallback = analysis.principal_variation || (analysis.best_move ? [analysis.best_move] : null);
        if (!out.length && (flagged || opts.lines === 'all') && fallback) {
            const line = playSan(ChessCtor, fenBefore, fallback, opts.maxPlies);
            if (line.length && !seen.has(bareSan(line[0].san))) {
                const ev = evalTag(analysis.best_evaluation);
                out.push(variationTokens(line, [ev ? `[%eval ${ev}]` : '', 'Best'].filter(Boolean).join(' ')));
            }
        }
        return out;
    }

    function moveComment(move, opts, index) {
        const analysis = move.analysis || {};
        const why = analysis.why || {};
        const key = qualityKey(move);
        const parts = [];

        const ev = opts.evals ? evalTag(move.evaluation) : null;
        if (ev) parts.push(`[%eval ${ev}]`);

        const showText = opts.lines === 'all' || isFlagged(move) || key === 'brilliant' || key === 'great';
        if (showText) {
            const sentences = [];
            if (QUALITY_LABELS[key] && key !== 'good') sentences.push(`${QUALITY_LABELS[key]}.`);
            // The Why card's top alternative wins over best_move (it may come from a deeper re-search)
            const topAlt = Array.isArray(why.alternatives) && why.alternatives[0];
            const best = topAlt && topAlt.verdict === 'better' ? topAlt.san : analysis.best_move;
            const bestEval = topAlt && topAlt.verdict === 'better' ? topAlt.evaluation : analysis.best_evaluation;
            const main = (why.bluf && why.bluf.text) || analysis.explanation || '';
            if (isFlagged(move) && best && bareSan(best) !== bareSan(move.move) && !main.includes(`Better was ${best}`)) {
                sentences.push(`${best} was best${bestEval ? ` (${bestEval})` : ''}.`);
            }
            if (main) sentences.push(main);
            // A threat is moot once the move ends the game
            if (why.threat && why.threat.text && !/#$/.test(move.move)) sentences.push(why.threat.text);
            const text = cleanComment(sentences.join(' '));
            if (text) parts.push(text);
        }

        const note = opts.notes && opts.notes[index];
        if (note) parts.push(cleanComment(note));
        return parts.join(' ');
    }

    /** Punishment line for moves[index], to hang after the reply actually played. */
    function refutationLine(ChessCtor, move, fenAfter, opts) {
        const analysis = move.analysis || {};
        if (!analysis.refutation_variation && !analysis.refutation) return [];
        return playSan(ChessCtor, fenAfter, analysis.refutation_variation || [analysis.refutation], opts.maxPlies);
    }

    function wrap(tokens, width) {
        const lines = [];
        let cur = '';
        // Keep [%eval 1.20] in one piece so readers that scan line by line still see it
        const text = tokens.join(' ').replace(/\( /g, '(').replace(/ \)/g, ')').replace(/\[%(\w+) ([^\]\s]+)\]/g, '[%$1\u0000$2]');
        text.split(' ').forEach(raw => {
            const word = raw.replace(/\u0000/g, ' ');
            if (!word) return;
            if (cur && cur.length + 1 + word.length > width) {
                lines.push(cur);
                cur = word;
            } else {
                cur = cur ? `${cur} ${word}` : word;
            }
        });
        if (cur) lines.push(cur);
        return lines.join('\n');
    }

    function normalizeResult(result) {
        const r = String(result || '').trim().replace('½-½', '1/2-1/2');
        return RESULTS.includes(r) ? r : '*';
    }

    /**
     * Build the annotated PGN.
     *
     * @param {Array} moves analyzed moves (output contract in AGENTS.md)
     * @param {object} [options]
     *   gameInfo   { white, black, date, event, site, result, white_elo, black_elo, eco, opening }
     *   accuracy   { white, black } shown in the opening comment
     *   depth      engine depth, shown in the opening comment
     *   lines      'key' (default: engine lines for inaccuracies/mistakes/misses/blunders),
     *              'all' (every move), or 'none'
     *   evals      include [%eval] tags (default true)
     *   notes      { [moveIndex]: text } appended to that move's comment
     *   extraLines [{ startFen, moves: [san...], comment }] e.g. the player's own lines;
     *              each hangs off the mainline position matching startFen
     *   maxPlies   cap on plies per variation (default 10)
     *   Chess      chess.js constructor (auto-detected)
     * @returns {string}
     */
    function build(moves, options) {
        const opts = Object.assign({ lines: 'key', evals: true, maxPlies: DEFAULT_MAX_PLIES }, options || {});
        const ChessCtor = getChessConstructor(opts.Chess);
        if (!ChessCtor) throw new Error('PgnExport.build requires chess.js');
        const list = Array.isArray(moves) ? moves : [];
        const info = opts.gameInfo || {};
        const result = normalizeResult(info.result);

        // Replay the game once: fens[i] is the position before moves[i]
        const board = new ChessCtor();
        const fens = [];
        const played = [];
        for (let i = 0; i < list.length; i++) {
            const fen = board.fen();
            let m = null;
            try { m = board.move(list[i].move); } catch (e) { m = null; }
            if (!m) {
                try { m = board.move(bareSan(list[i].move)); } catch (e) { m = null; }
            }
            if (!m) break;
            fens.push(fen);
            played.push(m.san);
        }
        fens.push(board.fen());

        const headers = [
            ['Event', info.event || '?'],
            ['Site', info.site || '?'],
            ['Date', info.date || '????.??.??'],
            ['Round', info.round || '-'],
            ['White', info.white || '?'],
            ['Black', info.black || '?'],
            ['Result', result]
        ];
        if (info.white_elo) headers.push(['WhiteElo', info.white_elo]);
        if (info.black_elo) headers.push(['BlackElo', info.black_elo]);
        if (info.eco) headers.push(['ECO', info.eco]);
        if (info.opening) headers.push(['Opening', info.opening]);
        headers.push(['Annotator', 'WhyBlunder']);
        const headerText = headers.map(([k, v]) => `[${k} "${headerValue(v)}"]`).join('\n');

        // Extra lines grouped by the mainline ply they replace
        const extraByIndex = {};
        (opts.extraLines || []).forEach(x => {
            if (!x || !x.startFen || !Array.isArray(x.moves) || !x.moves.length) return;
            const start = fens.findIndex(f => sameFen(f, x.startFen));
            if (start < 0) return;
            const full = playSan(ChessCtor, fens[start], x.moves, Math.max(opts.maxPlies, x.moves.length));
            // Branch where the line leaves the game; a line that never does adds nothing
            let j = 0;
            while (j < full.length && start + j < played.length && full[j].san === played[start + j]) j++;
            const line = full.slice(j);
            if (!line.length) return;
            const idx = start + j;
            (extraByIndex[idx] = extraByIndex[idx] || []).push({ line, comment: cleanComment(x.comment || '') });
        });

        const tokens = [];
        const intro = [];
        if (opts.accuracy && (opts.accuracy.white !== null && opts.accuracy.white !== undefined)) {
            const fmt = v => (v === null || v === undefined || !isFinite(v)) ? '-' : Number(v).toFixed(1);
            intro.push(`Accuracy: White ${fmt(opts.accuracy.white)}, Black ${fmt(opts.accuracy.black)}.`);
        }
        if (info.opening) intro.push(`${info.eco ? `${info.eco} ` : ''}${info.opening}.`);
        tokens.push(`{ Annotated by WhyBlunder${opts.depth ? ` (Stockfish depth ${opts.depth})` : ''}.${intro.length ? ` ${intro.join(' ')}` : ''} }`);

        let needNumber = true;
        for (let i = 0; i < played.length; i++) {
            const move = list[i];
            tokens.push(moveToken(fens[i], played[i], needNumber));
            needNumber = false;
            const nag = QUALITY_NAGS[qualityKey(move)];
            if (nag) tokens.push(nag);

            const comment = moveComment(move, opts, i);
            if (comment) {
                tokens.push(`{ ${comment} }`);
                needNumber = true;
            }

            const variations = [];
            if (opts.lines !== 'none' && (opts.lines === 'all' || isFlagged(move))) {
                variations.push(...engineVariations(ChessCtor, move, fens[i], opts));
            }
            // The previous move's punishment, unless this reply (or its own best line) already shows it
            const prev = i > 0 ? list[i - 1] : null;
            if (opts.lines !== 'none' && prev && isFlagged(prev)) {
                const ref = refutationLine(ChessCtor, prev, fens[i], opts);
                const first = ref.length ? bareSan(ref[0].san) : '';
                const shown = variations.some(v => v[1] && bareSan(v[1].replace(/^\d+\.(\.\.)?\s*/, '')) === first);
                if (first && first !== bareSan(played[i]) && !shown) {
                    variations.push(variationTokens(ref, `Punishes ${played[i - 1]}`));
                }
            }
            (extraByIndex[i] || []).forEach(x => variations.push(variationTokens(x.line, x.comment)));
            variations.forEach(v => tokens.push(...v));
            if (variations.length) needNumber = true;
        }

        // A last-move blunder has no reply to hang its punishment on
        const last = list[played.length - 1];
        if (opts.lines !== 'none' && last && isFlagged(last)) {
            const ref = refutationLine(ChessCtor, last, fens[played.length], opts);
            if (ref.length) {
                tokens.push(`{ ${cleanComment(`The punishment was ${lineTokens(ref).join(' ')}.`)} }`);
            }
        }
        // Lines from the final position cannot be variations either
        (extraByIndex[played.length] || []).forEach(x => {
            tokens.push(`{ ${cleanComment(`${x.comment || 'Line'}: ${lineTokens(x.line).join(' ')}`)} }`);
        });
        tokens.push(result);

        return `${headerText}\n\n${wrap(tokens, LINE_WIDTH)}\n`;
    }

    /** "Magnus_vs_Hikaru_2024.01.31.pgn" (safe on every file system). */
    function fileName(gameInfo) {
        const info = gameInfo || {};
        const part = v => String(v || '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
        const white = part(info.white) || 'White';
        const black = part(info.black) || 'Black';
        const date = info.date && !/\?/.test(info.date) ? `_${part(info.date)}` : '';
        return `${white}_vs_${black}${date}_annotated.pgn`;
    }

    return {
        build,
        fileName,
        evalTag,
        cleanComment,
        qualityKey,
        QUALITY_NAGS
    };
}));
