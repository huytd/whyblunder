/**
 * self-review.js - "Review it yourself first" for WhyBlunder.
 *
 * Good game analysis starts with the player's own thinking and only then turns
 * to the engine. This module plans that walk-through and scores it afterwards:
 *
 *   1. buildPlan()  - split the game into opening / middlegame / endgame and pick
 *                     the critical moments for one side from the engine data,
 *                     without exposing how any move was classified.
 *   2. (UI)         - the player rates each position and move, may suggest a
 *                     better move and writes what they were thinking.
 *   3. compare()    - line the answers up against the engine: mistakes spotted,
 *                     evaluation calibration (over- or under-optimism), moves found.
 *
 * Pure and deterministic: no DOM, no engine, no randomness.
 */
(function(root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.SelfReview = factory();
    }
}(typeof self !== 'undefined' ? self : this, function() {
    'use strict';

    const STORAGE_KEY = 'whyblunder_self_review_v1';
    const MAX_STORED_GAMES = 30;
    const MATE_SCORE_CP = 10000;

    const PHASES = ['opening', 'middlegame', 'endgame'];
    const PHASE_LABELS = { opening: 'Opening', middlegame: 'Middlegame', endgame: 'Endgame' };

    // How the player felt about the position, from their own side (rank 0 = losing).
    const EVAL_CHOICES = [
        { key: 'losing', label: 'Losing', rank: 0 },
        { key: 'worse', label: 'Worse', rank: 1 },
        { key: 'equal', label: 'Equal', rank: 2 },
        { key: 'better', label: 'Better', rank: 3 },
        { key: 'winning', label: 'Winning', rank: 4 }
    ];

    // How the player rates the move they played (level 0 = strongest).
    const MOVE_CHOICES = [
        { key: 'strong', label: 'Strong', level: 0 },
        { key: 'fine', label: 'Fine', level: 1 },
        { key: 'dubious', label: 'Dubious', level: 2 },
        { key: 'bad', label: 'Bad', level: 3 }
    ];

    const ERROR_QUALITIES = ['mistake', 'blunder', 'missed win', 'miss'];
    const MAX_MOMENTS = 8;
    const MAX_PER_PHASE = 3;
    const MIN_MOMENT_SCORE = 35;

    function quality(move) {
        return String((move && (move.detailed_quality || move.quality)) || '').toLowerCase().trim();
    }

    function uiQuality(move) {
        return String((move && move.quality) || '').toLowerCase().trim();
    }

    function cpToWinProb(cp) {
        return 1 / (1 + Math.pow(10, -cp / 400));
    }

    /** "+1.20" / "-0.35" / "M3" / "-M2" (White POV) -> centipawns, or null. */
    function parseEval(text) {
        if (text === null || text === undefined) return null;
        const s = String(text).trim().replace(/^#/, 'M').replace(/^-#/, '-M');
        const mate = s.match(/^([+-]?)M(\d+)$/i);
        if (mate) {
            const plies = parseInt(mate[2], 10);
            const cp = MATE_SCORE_CP - 10 * plies;
            return mate[1] === '-' ? -cp : cp;
        }
        const n = parseFloat(s);
        if (!isFinite(n)) return null;
        return Math.round(n * 100);
    }

    /** The mover's win probability in the position they faced (engine's best line). */
    function moverWpBefore(move) {
        if (!move) return null;
        const a = move.analysis || {};
        const whiteCp = parseEval(a.best_evaluation);
        if (whiteCp !== null) {
            const wp = cpToWinProb(whiteCp);
            return move.is_white ? wp : 1 - wp;
        }
        if (typeof move.win_probability === 'number') {
            return Math.min(1, move.win_probability + (Number(move.win_prob_loss) || 0));
        }
        return null;
    }

    /** The mover's win probability after the move was played. */
    function moverWpAfter(move) {
        if (!move) return null;
        if (typeof move.win_probability === 'number') return move.win_probability;
        const whiteCp = parseEval(move.evaluation);
        if (whiteCp === null) return null;
        const wp = cpToWinProb(whiteCp);
        return move.is_white ? wp : 1 - wp;
    }

    /** Win probability (for `side`, 'w'|'b') -> one of EVAL_CHOICES keys. */
    function evalKeyFromWp(wp) {
        if (wp === null || wp === undefined || !isFinite(wp)) return null;
        if (wp >= 0.90) return 'winning';
        if (wp >= 0.57) return 'better';
        if (wp > 0.43) return 'equal';
        if (wp > 0.10) return 'worse';
        return 'losing';
    }

    function evalRank(key) {
        const c = EVAL_CHOICES.find(x => x.key === key);
        return c ? c.rank : null;
    }

    function moveLevel(key) {
        const c = MOVE_CHOICES.find(x => x.key === key);
        return c ? c.level : null;
    }

    /** Engine verdict on a played move on the same 0..3 scale as MOVE_CHOICES. */
    function engineMoveLevel(move) {
        const q = quality(move);
        if (['brilliant', 'great', 'best'].includes(q)) return 0;
        if (['excellent', 'good', 'good move', 'book'].includes(q)) return 1;
        if (q === 'inaccuracy') return 2;
        if (ERROR_QUALITIES.includes(q)) return 3;
        return uiQuality(move) === 'best' ? 0 : 1;
    }

    function isError(move) {
        return ERROR_QUALITIES.includes(quality(move)) || ERROR_QUALITIES.includes(uiQuality(move));
    }

    function sideOf(move) {
        return move && move.is_white ? 'white' : 'black';
    }

    function bareSan(san) {
        return String(san || '').replace(/[?!+#]+$/g, '').trim();
    }

    /**
     * Phase for every ply, made monotonic (a game never goes back to the opening):
     * gamePhase() reads material, which a promotion can push back up.
     */
    function phaseSequence(moves, fens, phaseOf) {
        const out = [];
        let floor = 0;
        (moves || []).forEach((m, i) => {
            let p = 'middlegame';
            if (typeof phaseOf === 'function') {
                try { p = phaseOf(fens ? fens[i] : null) || 'middlegame'; } catch (e) { p = 'middlegame'; }
            }
            let idx = PHASES.indexOf(p);
            if (idx < 0) idx = 1;
            floor = Math.max(floor, idx);
            out.push(PHASES[floor]);
        });
        return out;
    }

    /** [{ phase, label, start, end }] contiguous ply ranges, in game order. */
    function phaseRanges(moves, fens, phaseOf) {
        const seq = phaseSequence(moves, fens, phaseOf);
        const ranges = [];
        seq.forEach((phase, i) => {
            const last = ranges[ranges.length - 1];
            if (last && last.phase === phase) {
                last.end = i;
            } else {
                ranges.push({ phase, label: PHASE_LABELS[phase], start: i, end: i });
            }
        });
        return ranges;
    }

    /**
     * How critical the decision at `index` was, for the moment picker. Mixes
     * errors with good finds (only moves, punishing an opponent's error) so the
     * list itself does not give away which moves were wrong.
     */
    function momentScore(moves, index, opts) {
        const move = moves[index];
        const q = quality(move);
        if (!move || q === 'book') return 0;
        if (opts && Array.isArray(opts.legalMoveCounts) && opts.legalMoveCounts[index] === 1) return 0;

        let score = 0;
        if (q === 'blunder' || q === 'missed win' || q === 'miss') score = 100;
        else if (q === 'mistake') score = 75;
        else if (q === 'brilliant') score = 80;
        else if (q === 'great') score = 65;
        else if (q === 'inaccuracy') score = 35;

        const loss = Number(move.win_prob_loss) || 0;
        score += Math.min(30, Math.round(loss * 100));

        // The opponent just erred: did the player take the chance?
        const prev = moves[index - 1];
        if (prev && prev.is_white !== move.is_white && isError(prev)) {
            score = Math.max(score, 55) + 10;
        }

        // Only move: every engine alternative is clearly worse than the best line.
        const why = move.analysis && move.analysis.why;
        const alts = why && Array.isArray(why.alternatives) ? why.alternatives : [];
        const bestWp = moverWpBefore(move);
        if (engineMoveLevel(move) === 0 && alts.length > 0 && bestWp !== null &&
            alts.every(a => typeof a.wp === 'number' && bestWp - a.wp >= 0.15)) {
            score = Math.max(score, 50);
        }

        const tags = Array.isArray(move.tags) ? move.tags.join(' ').toLowerCase() : '';
        if (tags.includes('checkmate') || tags.includes('missed mate') || tags.includes('missed win')) score += 20;
        return score;
    }

    /**
     * Pick the critical moments for one side.
     * @param {Array} moves analyzed moves (output contract)
     * @param {object} opts { side: 'white'|'black', fens, phaseOf, legalMoveCounts, max, perPhase }
     * @returns {Array<{index, phase, score}>} in game order
     */
    function selectMoments(moves, opts) {
        const o = opts || {};
        const list = Array.isArray(moves) ? moves : [];
        const side = o.side === 'black' ? 'black' : 'white';
        const max = o.max || MAX_MOMENTS;
        const perPhase = o.perPhase || MAX_PER_PHASE;
        const phases = phaseSequence(list, o.fens, o.phaseOf);

        const scored = [];
        list.forEach((m, i) => {
            if (sideOf(m) !== side) return;
            scored.push({ index: i, phase: phases[i], score: momentScore(list, i, o) });
        });

        // Highest score first; ties go to the earlier move so the pick is stable.
        const ranked = scored.slice().sort((a, b) => (b.score - a.score) || (a.index - b.index));
        const picked = [];
        const perPhaseCount = {};
        const take = (c) => {
            if (picked.length >= max) return;
            if ((perPhaseCount[c.phase] || 0) >= perPhase) return;
            if (picked.some(p => p.index === c.index)) return;
            picked.push(c);
            perPhaseCount[c.phase] = (perPhaseCount[c.phase] || 0) + 1;
        };
        ranked.filter(c => c.score >= MIN_MOMENT_SCORE).forEach(take);

        // A clean game still deserves a few positions to think about.
        if (picked.length < 3) {
            ranked.filter(c => c.score > 0 || (Number(list[c.index].win_prob_loss) || 0) > 0.02).forEach(take);
        }

        return picked.sort((a, b) => a.index - b.index);
    }

    /**
     * The whole walk-through: phases in order, each with its moments.
     * Phases with no moves are dropped; phases with no moments keep a checkpoint.
     */
    function buildPlan(moves, opts) {
        const o = opts || {};
        const side = o.side === 'black' ? 'black' : 'white';
        const moments = selectMoments(moves, Object.assign({}, o, { side }));
        const ranges = phaseRanges(moves, o.fens, o.phaseOf);
        const phases = ranges.map(r => ({
            phase: r.phase,
            label: r.label,
            start: r.start,
            end: r.end,
            moments: moments.filter(m => m.index >= r.start && m.index <= r.end).map(m => m.index)
        }));
        return { side, phases, moments: moments.map(m => m.index) };
    }

    /** Flat list of steps the UI walks: phase intro, moments, phase checkpoint... then reveal. */
    function planSteps(plan) {
        const steps = [];
        (plan && plan.phases || []).forEach(p => {
            steps.push({ type: 'phase', phase: p.phase });
            p.moments.forEach(index => steps.push({ type: 'moment', phase: p.phase, index }));
            steps.push({ type: 'checkpoint', phase: p.phase });
        });
        steps.push({ type: 'reveal' });
        return steps;
    }

    /** Engine view of a phase: how the player stood after its last move. */
    function phaseEngineEval(moves, range, side) {
        const last = moves[range.end];
        if (!last) return null;
        const wpMover = moverWpAfter(last);
        if (wpMover === null) return null;
        const lastSide = sideOf(last);
        const wp = lastSide === side ? wpMover : 1 - wpMover;
        return { key: evalKeyFromWp(wp), wp, evaluation: last.evaluation || null };
    }

    function verdictFromDiff(diff) {
        if (diff === 0) return 'match';
        if (Math.abs(diff) === 1) return 'close';
        return 'off';
    }

    /** A moment counts as reviewed once the player has rated both the position and the move. */
    function isMomentReviewed(answer) {
        return Boolean(answer && answer.eval && answer.rating);
    }

    /**
     * Review state of one critical moment: 'reviewed', 'needs-review' (the player
     * opened it and left without answering) or 'pending' (not opened yet).
     */
    function momentStatus(index, answers, visited) {
        const a = answers && answers.moments ? answers.moments[index] : null;
        if (isMomentReviewed(a)) return 'reviewed';
        const seen = Array.isArray(visited) && visited.some(v => Number(v) === Number(index));
        return seen ? 'needs-review' : 'pending';
    }

    /** Moments still unanswered in the given phases (all phases when `phases` is empty), in game order. */
    function unreviewedMoments(plan, answers, phases) {
        const only = Array.isArray(phases) ? phases : (phases ? [phases] : []);
        return ((plan && plan.phases) || [])
            .filter(p => only.length === 0 || only.includes(p.phase))
            .reduce((all, p) => all.concat(p.moments), [])
            .filter(i => !isMomentReviewed(answers && answers.moments ? answers.moments[i] : null));
    }

    /**
     * Moments that must be reviewed before moving from step `from` to step `to`
     * (indices into planSteps()).
     * Moving back or within a phase is always allowed. Moving into a later phase
     * needs every earlier phase done, and the final comparison needs all of them.
     */
    function stepBlockers(plan, steps, answers, from, to) {
        const list = steps || [];
        const target = list[to];
        const current = list[from];
        if (!target || !current || to <= from) return [];
        if (target.type === 'reveal') return unreviewedMoments(plan, answers, []);
        const order = ((plan && plan.phases) || []).map(p => p.phase);
        const targetOrder = order.indexOf(target.phase);
        const currentOrder = order.indexOf(current.phase);
        if (targetOrder <= currentOrder) return [];
        return unreviewedMoments(plan, answers, order.slice(0, targetOrder));
    }

    /** Candidate move vs engine: 'best' | 'good' | 'ok' | 'worse' | 'played' | null (unknown). */
    function candidateVerdict(move, candidateSan, candidateWp) {
        const cand = bareSan(candidateSan);
        if (!cand || !move) return null;
        const a = move.analysis || {};
        if (bareSan(move.move) === cand) return 'played';
        if (bareSan(a.best_move) === cand) return 'best';
        let wp = typeof candidateWp === 'number' ? candidateWp : null;
        if (wp === null) {
            const alts = (a.why && Array.isArray(a.why.alternatives)) ? a.why.alternatives : [];
            const alt = alts.find(x => bareSan(x.san) === cand);
            if (alt && typeof alt.wp === 'number') wp = alt.wp;
        }
        const bestWp = moverWpBefore(move);
        if (wp === null || bestWp === null) return null;
        const gap = bestWp - wp;
        if (gap < 0.04) return 'good';
        if (gap < 0.12) return 'ok';
        return 'worse';
    }

    /**
     * Line up the player's answers with the engine.
     * @param {Array} moves analyzed moves
     * @param {object} plan from buildPlan()
     * @param {object} answers { moments: { [index]: { eval, rating, candidate, note } },
     *                           phases: { [phase]: { eval, note } } }
     * @param {object} [opts] { fens, phaseOf, candidateWps: { [index]: moverWp } }
     */
    function compare(moves, plan, answers, opts) {
        const o = opts || {};
        const side = plan && plan.side === 'black' ? 'black' : 'white';
        const ans = answers || {};
        const momentAnswers = ans.moments || {};
        const phaseAnswers = ans.phases || {};
        const candidateWps = o.candidateWps || {};

        const rows = (plan && plan.moments || []).map(index => {
            const move = moves[index];
            const a = momentAnswers[index] || {};
            const engineLevel = engineMoveLevel(move);
            const userLevel = moveLevel(a.rating);
            const engineEval = evalKeyFromWp(moverWpBefore(move));
            const userEvalRank = evalRank(a.eval);
            const engineEvalRank = evalRank(engineEval);
            return {
                index,
                move,
                note: a.note || '',
                rating: a.rating || null,
                userLevel,
                engineLevel,
                engineQuality: quality(move),
                isError: isError(move),
                moveVerdict: userLevel === null ? null : verdictFromDiff(userLevel - engineLevel),
                userEval: a.eval || null,
                engineEval,
                evalDiff: (userEvalRank === null || engineEvalRank === null) ? null : userEvalRank - engineEvalRank,
                evalVerdict: (userEvalRank === null || engineEvalRank === null) ? null : verdictFromDiff(userEvalRank - engineEvalRank),
                candidate: a.candidate || null,
                candidateVerdict: candidateVerdict(move, a.candidate, candidateWps[index]),
                bestMove: (move && move.analysis && move.analysis.best_move) || null,
                bestEvaluation: (move && move.analysis && move.analysis.best_evaluation) || null
            };
        });

        const ranges = phaseRanges(moves, o.fens, o.phaseOf);
        const phases = (plan && plan.phases || []).map(p => {
            const range = ranges.find(r => r.phase === p.phase) || p;
            const engine = phaseEngineEval(moves, range, side);
            const a = phaseAnswers[p.phase] || {};
            const ur = evalRank(a.eval);
            const er = engine ? evalRank(engine.key) : null;
            return {
                phase: p.phase,
                label: PHASE_LABELS[p.phase],
                start: p.start,
                end: p.end,
                userEval: a.eval || null,
                note: a.note || '',
                engineEval: engine ? engine.key : null,
                engineEvaluation: engine ? engine.evaluation : null,
                evalDiff: (ur === null || er === null) ? null : ur - er,
                evalVerdict: (ur === null || er === null) ? null : verdictFromDiff(ur - er),
                rows: rows.filter(r => r.index >= p.start && r.index <= p.end)
            };
        });

        const errors = rows.filter(r => r.isError);
        const rated = rows.filter(r => r.userLevel !== null);
        const evals = rows.filter(r => r.evalDiff !== null).concat(phases.filter(p => p.evalDiff !== null));
        const tried = rows.filter(r => r.candidate && r.candidateVerdict && r.candidateVerdict !== 'played');

        const totals = {
            moments: rows.length,
            errorsTotal: errors.length,
            errorsSpotted: errors.filter(r => r.userLevel !== null && r.userLevel >= 2).length,
            falseAlarms: rows.filter(r => !r.isError && r.engineLevel <= 1 && r.userLevel !== null && r.userLevel >= 2).length,
            ratingsMatched: rated.filter(r => r.moveVerdict !== 'off').length,
            ratingsAnswered: rated.length,
            evalsMatched: evals.filter(r => r.evalVerdict !== 'off').length,
            evalsAnswered: evals.length,
            candidatesTried: tried.length,
            candidatesGood: tried.filter(r => r.candidateVerdict === 'best' || r.candidateVerdict === 'good').length,
            evalBias: null
        };
        if (evals.length >= 3) {
            const avg = evals.reduce((s, r) => s + r.evalDiff, 0) / evals.length;
            if (avg >= 0.6) totals.evalBias = 'optimistic';
            else if (avg <= -0.6) totals.evalBias = 'pessimistic';
        }

        return { side, rows, phases, totals, takeaways: takeaways(rows, phases, totals) };
    }

    /** Up to three plain-language lessons, most important first. */
    function takeaways(rows, phases, totals) {
        const out = [];
        const missed = rows.filter(r => r.isError && (r.userLevel === null || r.userLevel <= 1));
        if (missed.length > 0) {
            const first = missed[0];
            out.push(`You didn't flag ${moveLabel(first.move)} as a problem, but the engine counts it as a ${qualityWord(first)}. Go back to that position and look for what you missed.`);
        }
        if (totals.evalBias === 'optimistic') {
            out.push('You often thought your position was better than it was. Before committing to a plan, ask what your opponent is threatening.');
        } else if (totals.evalBias === 'pessimistic') {
            out.push('You often thought your position was worse than it was. Trust your position more, and look for active moves before defending.');
        }
        if (totals.errorsTotal > 0 && totals.errorsSpotted === totals.errorsTotal) {
            out.push(`You spotted all ${totals.errorsTotal === 1 ? 'of your mistakes' : `${totals.errorsTotal} of your mistakes`} yourself. Your judgement after the game is good, so the next step is to see these moments during the game.`);
        }
        if (totals.candidatesTried > 0 && totals.candidatesGood > 0) {
            out.push(`You found an engine-approved move in ${totals.candidatesGood} of ${totals.candidatesTried} position${totals.candidatesTried === 1 ? '' : 's'} where you suggested an improvement.`);
        }
        const weakPhase = phases.find(p => p.rows.some(r => r.isError) && p.rows.filter(r => r.isError).length >= 2);
        if (weakPhase) {
            out.push(`Most of your problems came in the ${weakPhase.label.toLowerCase()}. Make it the focus of your next study session.`);
        }
        if (out.length === 0) {
            out.push('No big surprises: your own review matches the engine well. Look at the engine\'s alternatives to fine-tune your play.');
        }
        return out.slice(0, 3);
    }

    function moveLabel(move) {
        if (!move) return 'a move';
        return `${move.move_number}${move.is_white ? '.' : '...'} ${bareSan(move.move)}`;
    }

    function qualityWord(row) {
        const q = row.engineQuality;
        if (q === 'missed win' || q === 'miss') return 'missed win';
        return q || 'mistake';
    }

    /** Stable key for a game from its move list (deterministic, no PGN headers). */
    function gameKey(moves) {
        const text = (moves || []).map(m => bareSan(m && m.move)).join(' ');
        let hash = 5381;
        for (let i = 0; i < text.length; i++) {
            hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
        }
        return 'g' + (hash >>> 0).toString(36) + '_' + (moves || []).length;
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
            const parsed = JSON.parse(s.getItem(STORAGE_KEY) || '{}');
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (e) {
            return {};
        }
    }

    function load(key, storage) {
        const all = readAll(storage);
        return all[key] || null;
    }

    /** Save one game's review, keeping the most recently updated MAX_STORED_GAMES. */
    function save(key, data, storage, now) {
        const s = getStorage(storage);
        if (!s || !key) return false;
        const all = readAll(s);
        all[key] = Object.assign({}, data, { updatedAt: typeof now === 'number' ? now : Date.now() });
        const keys = Object.keys(all).sort((a, b) => (all[b].updatedAt || 0) - (all[a].updatedAt || 0));
        keys.slice(MAX_STORED_GAMES).forEach(k => { delete all[k]; });
        try {
            s.setItem(STORAGE_KEY, JSON.stringify(all));
            return true;
        } catch (e) {
            return false;
        }
    }

    function remove(key, storage) {
        const s = getStorage(storage);
        if (!s) return;
        const all = readAll(s);
        delete all[key];
        try { s.setItem(STORAGE_KEY, JSON.stringify(all)); } catch (e) {}
    }

    return {
        STORAGE_KEY,
        PHASES,
        PHASE_LABELS,
        EVAL_CHOICES,
        MOVE_CHOICES,
        parseEval,
        moverWpBefore,
        moverWpAfter,
        evalKeyFromWp,
        engineMoveLevel,
        momentScore,
        phaseSequence,
        phaseRanges,
        selectMoments,
        buildPlan,
        planSteps,
        isMomentReviewed,
        momentStatus,
        unreviewedMoments,
        stepBlockers,
        candidateVerdict,
        compare,
        gameKey,
        load,
        save,
        remove
    };
}));
