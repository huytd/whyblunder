/**
 * browser-analyzer.js - Multi-Worker Parallel Client-Side Stockfish WASM Game Analyzer for WhyBlunder.
 * Runs a pool of Stockfish Web Workers, parses UCI output, and executes game analysis in parallel.
 */
(function(root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.BrowserWhyBlunder = factory();
        root.BrowserChessDoctor = root.BrowserWhyBlunder;
    }
}(typeof self !== 'undefined' ? self : this, function() {
    'use strict';

    function getWorkerPath() {
        if (typeof window !== 'undefined' && window.STOCKFISH_WORKER_PATH) {
            return window.STOCKFISH_WORKER_PATH;
        }
        const wasmSupported = typeof WebAssembly === 'object' && 
            WebAssembly.validate(Uint8Array.of(0x0, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00));
        return wasmSupported ? 'js/stockfish.wasm.js' : 'js/stockfish.js';
    }

    class StockfishWorker {
        constructor(id = 0) {
            this.id = id;
            this.worker = null;
            this.isReady = false;
            this.isBusy = false;
            this.readyPromise = null;
            this.currentResolve = null;
            this.currentReject = null;
            this.currentEvalData = null;
            this.evalTimeout = null;
        }

        init() {
            if (this.worker && this.isReady) return Promise.resolve();
            if (this.readyPromise) return this.readyPromise;

            const workerPath = getWorkerPath();
            try {
                this.worker = new Worker(workerPath);
            } catch (err) {
                return Promise.reject(err);
            }

            this.readyPromise = new Promise((resolve, reject) => {
                const onInitialMessage = (e) => {
                    const line = typeof e.data === 'string' ? e.data : (e.data?.data || '');
                    if (line === 'uciok') {
                        this.worker.postMessage('setoption name Hash value 32');
                        this.worker.postMessage('setoption name MultiPV value 3');
                        this.worker.postMessage('isready');
                    } else if (line === 'readyok') {
                        this.isReady = true;
                        this.worker.removeEventListener('message', onInitialMessage);
                        this.worker.addEventListener('message', this._onMessage.bind(this));
                        resolve();
                    }
                };
                this.worker.addEventListener('message', onInitialMessage);
                this.worker.addEventListener('error', (err) => {
                    reject(err);
                });
                this.worker.postMessage('uci');
            });

            return this.readyPromise;
        }

        _onMessage(e) {
            const line = typeof e.data === 'string' ? e.data : (e.data?.data || '');
            if (!this.currentEvalData) return;

            // Parse info line
            if (line.startsWith('info ') && line.includes('multipv ')) {
                this._parseInfoLine(line);
            } else if (line.startsWith('bestmove ')) {
                if (this.evalTimeout) {
                    clearTimeout(this.evalTimeout);
                    this.evalTimeout = null;
                }
                const parts = line.split(' ');
                const bestMove = parts[1] || '';
                const resolve = this.currentResolve;
                const evalData = this.currentEvalData;
                this.currentResolve = null;
                this.currentReject = null;
                this.currentEvalData = null;
                if (resolve) {
                    resolve({ bestMove, ...evalData });
                }
            }
        }

        _parseInfoLine(line) {
            if (!this.currentEvalData) return;
            const tokens = line.split(' ');
            let multipv = 1;
            let cp = null;
            let mate = null;
            let pv = [];

            for (let i = 0; i < tokens.length; i++) {
                if (tokens[i] === 'multipv' && i + 1 < tokens.length) {
                    multipv = parseInt(tokens[i + 1], 10);
                } else if (tokens[i] === 'score' && i + 2 < tokens.length) {
                    if (tokens[i + 1] === 'cp') {
                        cp = parseInt(tokens[i + 2], 10);
                    } else if (tokens[i + 1] === 'mate') {
                        mate = parseInt(tokens[i + 2], 10);
                    }
                } else if (tokens[i] === 'pv') {
                    pv = tokens.slice(i + 1);
                    break;
                }
            }

            if (!this.currentEvalData.lines[multipv]) {
                this.currentEvalData.lines[multipv] = {};
            }
            if (cp !== null) this.currentEvalData.lines[multipv].cp = cp;
            if (mate !== null) this.currentEvalData.lines[multipv].mate = mate;
            if (pv.length > 0) this.currentEvalData.lines[multipv].pv = pv;
        }

        evaluate(fen, depth = 10, multipv = 3) {
            if (!this.isReady || !this.worker) {
                return Promise.reject(new Error('Worker not initialized'));
            }

            // Immediate terminal check to prevent 20s worker timeout on positions with 0 legal moves
            const ChessCtor = (typeof Chess !== 'undefined' ? Chess : (typeof window !== 'undefined' ? window.Chess : null));
            if (ChessCtor && fen) {
                try {
                    const testChess = new ChessCtor(fen);
                    if (testChess.game_over && testChess.game_over()) {
                        const isMate = testChess.in_checkmate && testChess.in_checkmate();
                        return Promise.resolve({
                            bestMove: '',
                            lines: {
                                1: {
                                    cp: isMate ? -10000 : 0,
                                    mate: isMate ? -1 : undefined,
                                    pv: []
                                }
                            }
                        });
                    }
                } catch (e) {}
            }

            return new Promise((resolve, reject) => {
                this.currentResolve = resolve;
                this.currentReject = reject;
                this.currentEvalData = { lines: {} };

                // Safety timeout: 20s max per single position evaluation
                this.evalTimeout = setTimeout(() => {
                    if (this.currentResolve) {
                        const fallbackResolve = this.currentResolve;
                        const evalData = this.currentEvalData || { lines: {} };
                        this.currentResolve = null;
                        this.currentReject = null;
                        this.currentEvalData = null;
                        this.evalTimeout = null;
                        fallbackResolve({ bestMove: '', ...evalData });
                    }
                }, 20000);

                this.worker.postMessage(`setoption name MultiPV value ${multipv}`);
                this.worker.postMessage(`position fen ${fen}`);
                this.worker.postMessage(`go depth ${depth}`);
            });
        }

        stop() {
            if (this.evalTimeout) {
                clearTimeout(this.evalTimeout);
                this.evalTimeout = null;
            }
            if (this.worker) {
                this.worker.postMessage('stop');
            }
            if (this.currentReject) {
                const reject = this.currentReject;
                this.currentResolve = null;
                this.currentReject = null;
                this.currentEvalData = null;
                reject(new Error('Evaluation stopped'));
            }
            this.isBusy = false;
        }

        setOption(name, value) {
            if (this.worker) {
                this.worker.postMessage(`setoption name ${name} value ${value}`);
            }
        }

        terminate() {
            if (this.evalTimeout) {
                clearTimeout(this.evalTimeout);
                this.evalTimeout = null;
            }
            if (this.worker) {
                this.worker.terminate();
                this.worker = null;
            }
            this.isReady = false;
            this.isBusy = false;
            this.readyPromise = null;
            this.currentResolve = null;
            this.currentReject = null;
            this.currentEvalData = null;
        }
    }

    class StockfishWorkerPool {
        constructor(size = null) {
            if (!size) {
                const concurrency = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency)
                    ? navigator.hardwareConcurrency
                    : 4;
                // Auto pool size: 2 to 6 workers, leaving headroom for UI
                this.size = Math.max(2, Math.min(concurrency >= 4 ? concurrency - 1 : concurrency, 6));
            } else {
                this.size = Math.max(1, size);
            }
            this.workers = [];
            this.taskQueue = [];
            this.initPromise = null;
            this.isCancelled = false;
        }

        async init() {
            if (this.workers.length > 0 && this.workers.every(w => w.isReady)) return;
            if (this.initPromise) return this.initPromise;

            this.isCancelled = false;
            this.initPromise = (async () => {
                if (this.workers.length === 0) {
                    for (let i = 0; i < this.size; i++) {
                        this.workers.push(new StockfishWorker(i));
                    }
                }
                await Promise.all(this.workers.map(w => w.init()));
            })();

            return this.initPromise;
        }

        async evaluate(fen, depth = 10, multipv = 3) {
            if (this.isCancelled) {
                throw new Error('Evaluation cancelled');
            }
            await this.init();

            return new Promise((resolve, reject) => {
                this.taskQueue.push({ fen, depth, multipv, resolve, reject });
                this._processNext();
            });
        }

        _processNext() {
            if (this.isCancelled) return;

            // Loop through all idle workers and dispatch available tasks
            while (this.taskQueue.length > 0) {
                const idleWorker = this.workers.find(w => !w.isBusy && w.isReady);
                if (!idleWorker) break;

                const task = this.taskQueue.shift();
                idleWorker.isBusy = true; // Synchronously mark busy

                idleWorker.evaluate(task.fen, task.depth, task.multipv)
                    .then((res) => {
                        idleWorker.isBusy = false;
                        task.resolve(res);
                        this._processNext();
                    })
                    .catch((err) => {
                        idleWorker.isBusy = false;
                        task.reject(err);
                        this._processNext();
                    });
            }
        }

        cancelAll() {
            this.isCancelled = true;
            const tasks = this.taskQueue;
            this.taskQueue = [];
            tasks.forEach(t => t.reject(new Error('Evaluation cancelled')));
            this.workers.forEach(w => {
                w.stop();
                w.isBusy = false;
            });
            this.initPromise = null;
        }

        terminateAll() {
            this.cancelAll();
            this.workers.forEach(w => w.terminate());
            this.workers = [];
            this.initPromise = null;
        }
    }

    class BrowserWhyBlunder {
        constructor(concurrency = null) {
            this.pool = new StockfishWorkerPool(concurrency);
            this.isCancelled = false;
        }

        cancel() {
            this.isCancelled = true;
            if (this.pool) {
                this.pool.cancelAll();
            }
        }

        /**
         * Convert UCI move string (e.g. 'e2e4' or 'e7e8q') to SAN on a given chess.js instance.
         */
        _uciToSan(chessInstance, uciMove) {
            if (!uciMove || uciMove.length < 4) return '';
            const from = uciMove.substring(0, 2);
            const to = uciMove.substring(2, 4);
            const promotion = uciMove.length > 4 ? uciMove[4] : undefined;

            try {
                const m = chessInstance.move({ from, to, promotion });
                if (m) {
                    const san = m.san;
                    chessInstance.undo();
                    return san;
                }
            } catch (e) {
                // Ignore illegal move in PV
            }
            return uciMove;
        }

        /**
         * Format a PV array of UCI moves into readable SAN string.
         */
        _formatPv(chessInstance, uciMoves, maxMoves = 5) {
            if (!uciMoves || uciMoves.length === 0) return '';
            const temp = new Chess(chessInstance.fen());
            const tokens = [];

            for (let i = 0; i < Math.min(maxMoves, uciMoves.length); i++) {
                const uci = uciMoves[i];
                if (!uci || uci.length < 4) break;
                const from = uci.substring(0, 2);
                const to = uci.substring(2, 4);
                const promotion = uci.length > 4 ? uci[4] : undefined;

                try {
                    const isWhite = (temp.turn() === 'w');
                    const fenParts = temp.fen().split(' ');
                    const moveNum = parseInt(fenParts[5], 10) || 1;
                    const m = temp.move({ from, to, promotion });
                    if (!m) break;

                    if (isWhite) {
                        tokens.push(`${moveNum}. ${m.san}`);
                    } else {
                        if (i === 0) tokens.push(`${moveNum}... ${m.san}`);
                        else tokens.push(m.san);
                    }
                } catch (e) {
                    break;
                }
            }
            return tokens.join(' ');
        }

        /**
         * Analyze an entire chess game from PGN string directly in browser using parallel worker pool.
         * @param {string} pgnText
         * @param {function} onProgress - callback({ ply, totalPlies, percentage, move, moveNum, isWhite, depth, workers })
         * @param {number} depth - Stockfish search depth (default 18)
         * @param {number} concurrency - Number of parallel workers (optional)
         * @param {object} hooks - optional, for consumers that start work before the game is done:
         *   onStart({ game_info, sans }) once the game is parsed, before any search;
         *   onMove(moveResult, index) as soon as each ply's result is ready (any order). The threat
         *   pass at the end may still add analysis.why.threat to key moments.
         * @returns {Promise<object>} Complete analysisData JSON
         */
        async analyzeGame(pgnText, onProgress = null, depth = 18, concurrency = null, hooks = null) {
            this.isCancelled = false;
            const callHook = (name, ...args) => {
                if (!hooks || typeof hooks[name] !== 'function') return;
                try { hooks[name](...args); } catch (e) { /* a consumer's error never breaks the analysis */ }
            };

            if (concurrency && this.pool.size !== concurrency) {
                this.pool.terminateAll();
                this.pool = new StockfishWorkerPool(concurrency);
            }

            const fullChess = new Chess();
            const valid = fullChess.load_pgn(pgnText);
            if (!valid) {
                return {
                    game_info: {},
                    moves: [],
                    errors: ["Could not parse game from PGN input"]
                };
            }

            const header = fullChess.header() || {};
            const history = fullChess.history({ verbose: true });
            const totalPlies = history.length;

            const sanMoves = history.map(h => h.san);
            const { eco, name: openingName } = (typeof OpeningDetector !== 'undefined')
                ? OpeningDetector.identifyOpening(sanMoves)
                : { eco: 'A00', name: 'Standard Game' };

            const analysisData = {
                game_info: {
                    white: header.White || '?',
                    black: header.Black || '?',
                    date: header.Date || '????.??.??',
                    event: header.Event || '?',
                    result: header.Result || '',
                    white_elo: header.WhiteElo || header.white_elo || '',
                    black_elo: header.BlackElo || header.black_elo || '',
                    site: header.Site || '',
                    eco: eco,
                    opening: openingName
                },
                moves: [],
                errors: []
            };

            if (totalPlies === 0) {
                return analysisData;
            }
            callHook('onStart', { game_info: analysisData.game_info, sans: sanMoves.slice() });

            // Pre-calculate all board states and FENs sequentially
            const plyContexts = [];
            const tempBoard = new Chess();
            for (let ply = 0; ply < totalPlies; ply++) {
                const moveObj = history[ply];
                const fenBefore = tempBoard.fen();
                tempBoard.move({
                    from: moveObj.from,
                    to: moveObj.to,
                    promotion: moveObj.promotion
                });
                const fenAfter = tempBoard.fen();
                plyContexts.push({
                    ply,
                    moveObj,
                    moveNum: Math.floor(ply / 2) + 1,
                    isWhite: (ply % 2 === 0),
                    fenBefore,
                    fenAfter
                });
            }

            // Initialize worker pool in parallel
            await this.pool.init();
            if (this.isCancelled) {
                analysisData.errors.push("Analysis cancelled by user");
                return analysisData;
            }

            let completedCount = 0;
            const diagByPly = [];

            // Execute ply evaluations concurrently across the worker pool
            const plyPromises = plyContexts.map(async (ctx) => {
                if (this.isCancelled) return null;

                const { ply, moveObj, moveNum, isWhite, fenBefore, fenAfter } = ctx;
                const player = isWhite ? 'White' : 'Black';

                const boardBefore = new Chess(fenBefore);
                const boardAfter = new Chess(fenAfter);

                // 1. Adaptive search budget (phase + sharpness awareness)
                const Diagnostics = (typeof MoveDiagnostics !== 'undefined') ? MoveDiagnostics : null;
                const phase = (typeof ChessEvaluator !== 'undefined' && ChessEvaluator.gamePhase) ? ChessEvaluator.gamePhase(fenBefore) : 'middlegame';
                const budget = (Diagnostics && typeof Diagnostics.searchBudget === 'function')
                    ? Diagnostics.searchBudget({ phase, mode: 'analysis', baseDepth: depth })
                    : { depthPre: depth, depthPost: Math.max(8, depth - 2), multipv: 3 };

                // MultiPV analysis of position BEFORE move
                let preEval;
                try {
                    preEval = await this.pool.evaluate(fenBefore, budget.depthPre, budget.multipv);
                } catch (e) {
                    if (this.isCancelled) return null;
                    throw e;
                }
                if (this.isCancelled) return null;

                const bestUci = preEval.bestMove;
                const bestLine = preEval.lines[1] || { cp: 0, pv: [] };
                const bestScoreObj = { cp: bestLine.cp, mate: bestLine.mate };
                const bestSan = this._uciToSan(boardBefore, bestUci);
                const bestPvFormatted = this._formatPv(boardBefore, bestLine.pv);

                // Played move as UCI
                const playedUci = moveObj.from + moveObj.to + (moveObj.promotion || '');
                const playedIsBest = (playedUci === bestUci);

                // 2. Score after move & Refutation detection
                let playedScoreObj = bestScoreObj;
                let refUci = null;
                let refSan = null;
                let refFrom = null;
                let refTo = null;
                let refPv = [];
                let refPvFormatted = '';
                let postEval = null;

                if (playedIsBest) {
                    playedScoreObj = bestScoreObj;
                    if (bestLine.pv && bestLine.pv.length > 1) {
                        refUci = bestLine.pv[1];
                        refPv = bestLine.pv.slice(1);
                    }
                } else {
                    // Check if played move was found in MultiPV 2 or 3
                    let foundInMultipv = false;
                    for (let m = 2; m <= 3; m++) {
                        if (preEval.lines[m] && preEval.lines[m].pv && preEval.lines[m].pv[0] === playedUci) {
                            playedScoreObj = { cp: preEval.lines[m].cp, mate: preEval.lines[m].mate };
                            foundInMultipv = true;
                            break;
                        }
                    }

                    // Evaluate boardAfter to get opponent's refutation and exact score
                    try {
                        postEval = await this.pool.evaluate(fenAfter, budget.depthPost, 1);
                    } catch (e) {
                        if (this.isCancelled) return null;
                        throw e;
                    }
                    if (this.isCancelled) return null;

                    const postBest = postEval.lines[1] || {};
                    refUci = postEval.bestMove;

                    if (!foundInMultipv) {
                        // Invert post score to get player's score
                        if (postBest.mate !== undefined) {
                            playedScoreObj = { mate: -postBest.mate };
                        } else {
                            playedScoreObj = { cp: -(postBest.cp || 0) };
                        }
                    }
                    if (postBest.pv) {
                        refPv = postBest.pv;
                        refPvFormatted = this._formatPv(boardAfter, postBest.pv);
                    }
                }

                if (refUci && refUci.length >= 4) {
                    refSan = this._uciToSan(boardAfter, refUci);
                    refFrom = refUci.substring(0, 2);
                    refTo = refUci.substring(2, 4);
                }

                // 3. Win probabilities, Classification & Situation Recognition via MoveDiagnostics
                let diag = null;
                if (Diagnostics && typeof Diagnostics.diagnose === 'function') {
                    diag = Diagnostics.diagnose({
                        fenBefore,
                        fenAfter,
                        playedMove: moveObj,
                        engine: {
                            bestUci,
                            lines: preEval.lines,
                            post: postEval,
                            depthPre: budget.depthPre,
                            depthPost: budget.depthPost
                        },
                        context: {
                            ply: ply + 1,
                            sanHistory: sanMoves,
                            mode: 'analysis',
                            adaptive: true
                        }
                    });
                }

                // Threshold-boundary re-search:
                // When |wpLoss - threshold| < 0.015 near a classification boundary,
                // re-evaluate 2 plies deeper before committing to verdict.
                if (diag && diag.classification && budget.depthPre <= 20 && !this.isCancelled) {
                    const wpLoss = diag.classification.wpLoss || 0;
                    const THRESHOLDS = [0.04, 0.10, 0.22];
                    const isBoundary = THRESHOLDS.some(t => Math.abs(wpLoss - t) < 0.015);
                    if (isBoundary) {
                        try {
                            const deepPre = await this.pool.evaluate(fenBefore, budget.depthPre + 2, budget.multipv);
                            if (deepPre && deepPre.lines && deepPre.lines[1] && !this.isCancelled) {
                                preEval = deepPre;
                                const newBestUci = preEval.bestMove;
                                const newPlayedIsBest = (playedUci === newBestUci);
                                let newPostEval = postEval;
                                if (!newPlayedIsBest) {
                                    newPostEval = await this.pool.evaluate(fenAfter, budget.depthPost + 2, 1);
                                }
                                if (!this.isCancelled && Diagnostics && typeof Diagnostics.diagnose === 'function') {
                                    diag = Diagnostics.diagnose({
                                        fenBefore,
                                        fenAfter,
                                        playedMove: moveObj,
                                        engine: {
                                            bestUci: newBestUci,
                                            lines: preEval.lines,
                                            post: newPostEval,
                                            depthPre: budget.depthPre + 2,
                                            depthPost: budget.depthPost + 2
                                        },
                                        context: {
                                            ply: ply + 1,
                                            sanHistory: sanMoves,
                                            mode: 'analysis',
                                            adaptive: true
                                        }
                                    });
                                }
                            }
                        } catch (e) {
                            // Non-fatal: keep initial diag if re-search is interrupted or worker fails
                        }
                    }
                }

                const bestCp = diag ? (diag.bestScore?.cp || 0) : ((typeof ChessEvaluator !== 'undefined') ? ChessEvaluator.scoreToCp(bestScoreObj) : (bestScoreObj.cp || 0));
                const playedCp = diag ? (diag.playedScore?.cp || 0) : ((typeof ChessEvaluator !== 'undefined') ? ChessEvaluator.scoreToCp(playedScoreObj) : (playedScoreObj.cp || 0));
                const wpBefore = diag ? diag.wpBefore : ((typeof ChessEvaluator !== 'undefined') ? ChessEvaluator.cpToWinProb(bestCp) : 0.5);
                const wpAfter = diag ? diag.wpAfter : ((typeof ChessEvaluator !== 'undefined') ? ChessEvaluator.cpToWinProb(playedCp) : 0.5);
                const isBook = diag ? diag.isBook : ((typeof OpeningDetector !== 'undefined') ? OpeningDetector.isBookMove(sanMoves, ply + 1) : false);
                const classification = diag ? diag.classification : ((typeof ChessEvaluator !== 'undefined')
                    ? ChessEvaluator.classifyMove(wpBefore, wpAfter, { playedIsBest, isBook })
                    : { uiQuality: 'good move', detailedQuality: 'good', wpLoss: 0 });

                if (diag) diagByPly[ply] = diag;
                const explanation = diag ? diag.explanation : '';
                const tags = diag ? diag.tags : [];
                const flaw = diag ? diag.flaw : null;
                const missedChance = diag ? diag.missedChance : null;
                const betterLine = diag ? diag.betterLine : null;

                // Threats created by played move
                const threatsCreated = (typeof SituationRecognizer !== 'undefined')
                    ? SituationRecognizer.detectThreatsCreated(boardAfter, moveObj)
                    : [];

                // Convert mover score to White's perspective for standard display (+ for White, - for Black)
                const whitePlayedScore = isWhite ? playedScoreObj : {
                    cp: playedScoreObj.cp !== undefined ? -playedScoreObj.cp : undefined,
                    mate: playedScoreObj.mate !== undefined ? -playedScoreObj.mate : undefined
                };
                const whiteBestScore = isWhite ? bestScoreObj : {
                    cp: bestScoreObj.cp !== undefined ? -bestScoreObj.cp : undefined,
                    mate: bestScoreObj.mate !== undefined ? -bestScoreObj.mate : undefined
                };

                const currentMoveLine = isWhite ? `${moveNum}. ${moveObj.san}` : `${moveNum}. ... ${moveObj.san}`;
                const formattedEval = (typeof ChessEvaluator !== 'undefined')
                    ? ChessEvaluator.formatScore(whitePlayedScore, 'w')
                    : '+0.00';
                const formattedBestEval = (typeof ChessEvaluator !== 'undefined')
                    ? ChessEvaluator.formatScore(whiteBestScore, 'w')
                    : '+0.00';

                completedCount++;
                if (onProgress) {
                    const pct = Math.round((completedCount / totalPlies) * 100);
                    onProgress({
                        ply: completedCount,
                        totalPlies,
                        percentage: pct,
                        move: moveObj.san,
                        moveNum,
                        isWhite,
                        depth,
                        workers: this.pool.size
                    });
                }

                const result = {
                    move_number: moveNum,
                    ply: ply + 1,
                    move: moveObj.san,
                    player: player,
                    is_white: isWhite,
                    quality: classification.uiQuality,
                    detailed_quality: classification.detailedQuality,
                    evaluation: formattedEval,
                    score_cp: playedCp,
                    win_probability: Math.round(wpAfter * 1000) / 1000,
                    win_prob_loss: Math.round(classification.wpLoss * 1000) / 1000,
                    tags: tags,
                    notation: currentMoveLine,
                    analysis: {
                        best_move: bestSan,
                        explanation: explanation,
                        flaw: flaw,
                        missed_chance: missedChance,
                        better_line: betterLine,
                        best_evaluation: formattedBestEval,
                        principal_variation: bestPvFormatted,
                        tags: tags,
                        refutation: refSan,
                        refutation_variation: refPvFormatted,
                        refutation_from: refFrom,
                        refutation_to: refTo,
                        threats_created: threatsCreated,
                        why: diag ? diag.why : null
                    }
                };
                callHook('onMove', result, ply);
                return result;
            });

            const moveResults = await Promise.all(plyPromises);

            if (this.isCancelled) {
                analysisData.errors.push("Analysis cancelled by user");
                return analysisData;
            }

            // Threat pass: for key moments, mistakes and blunders, ask "what was the
            // opponent threatening?" with a shallow null-move search.
            await this._addThreats(moveResults, plyContexts, diagByPly, onProgress);
            if (this.isCancelled) {
                analysisData.errors.push("Analysis cancelled by user");
                return analysisData;
            }

            // Plies are guaranteed to preserve original chronological order (index 0 to totalPlies - 1)
            analysisData.moves = moveResults.filter(Boolean);
            return analysisData;
        }

        async _addThreats(moveResults, plyContexts, diagByPly, onProgress) {
            const Diagnostics = (typeof MoveDiagnostics !== 'undefined') ? MoveDiagnostics : null;
            const Evaluator = (typeof ChessEvaluator !== 'undefined') ? ChessEvaluator : null;
            if (!Diagnostics || !Diagnostics.nullMoveFen || !Diagnostics.describeThreat) return;

            const targets = [];
            moveResults.forEach((move, i) => {
                if (!move || !move.analysis || !move.analysis.why || !diagByPly[i]) return;
                const isKey = Evaluator && Evaluator.isKeyMoment ? Evaluator.isKeyMoment(move) : false;
                if (isKey || move.quality === 'mistake' || move.quality === 'blunder') targets.push(i);
            });

            let done = 0;
            await Promise.all(targets.map(async (i) => {
                if (this.isCancelled) return;
                const fenBefore = plyContexts[i].fenBefore;
                const nullFen = Diagnostics.nullMoveFen(fenBefore);
                if (!nullFen) return;
                try {
                    const nullEval = await this.pool.evaluate(nullFen, 12, 1);
                    if (this.isCancelled || !nullEval) return;
                    const threat = Diagnostics.describeThreat(fenBefore, nullEval, diagByPly[i].bestScore);
                    if (threat) moveResults[i].analysis.why.threat = threat;
                } catch (e) {
                    // Non-fatal: the move keeps its explanation without a threat row
                }
                done++;
                if (onProgress) {
                    onProgress({
                        phase: 'threats',
                        ply: done,
                        totalPlies: targets.length,
                        percentage: 100,
                        move: moveResults[i].move,
                        moveNum: moveResults[i].move_number,
                        isWhite: moveResults[i].is_white,
                        workers: this.pool.size
                    });
                }
            }));
        }
    }

    BrowserWhyBlunder.StockfishWorker = StockfishWorker;
    BrowserWhyBlunder.StockfishWorkerPool = StockfishWorkerPool;
    BrowserWhyBlunder.searchBudget = (typeof MoveDiagnostics !== 'undefined' && MoveDiagnostics.searchBudget)
        ? MoveDiagnostics.searchBudget
        : function(opts) { return { depthPre: opts?.baseDepth || 18, depthPost: Math.max(8, (opts?.baseDepth || 18) - 2), multipv: 3 }; };

    return BrowserWhyBlunder;
}));
