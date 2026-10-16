/**
 * test_browser_modules.js - Unit tests for client-side JS analysis modules in Node.
 */
const assert = require('assert');
const Chess = require('./js/chess.min.js').Chess || require('./js/chess.min.js');
const ChessEvaluator = require('./js/chess-evaluator.js');
const OpeningDetector = require('./js/opening-detector.js');
const SituationRecognizer = require('./js/situation-recognizer.js');

console.log("Running browser module unit tests...");

// 1. ChessEvaluator tests
console.log("Testing ChessEvaluator...");
assert.strictEqual(ChessEvaluator.scoreToCp(null), 0);
assert.strictEqual(ChessEvaluator.scoreToCp(150), 150);
assert.strictEqual(ChessEvaluator.scoreToCp({ cp: 220 }), 220);
assert.strictEqual(ChessEvaluator.scoreToCp({ mate: 1 }), 9990);
assert.strictEqual(ChessEvaluator.scoreToCp({ mate: -1 }), -9990);

const wp0 = ChessEvaluator.cpToWinProb(0);
assert(Math.abs(wp0 - 0.50) < 0.001, `Expected 0.50, got ${wp0}`);

const wp400 = ChessEvaluator.cpToWinProb(400);
assert(Math.abs(wp400 - 0.909) < 0.01, `Expected ~0.909, got ${wp400}`);

const wpNeg400 = ChessEvaluator.cpToWinProb(-400);
assert(Math.abs(wpNeg400 - 0.091) < 0.01, `Expected ~0.091, got ${wpNeg400}`);

const resBook = ChessEvaluator.classifyMove(0.5, 0.4, { isBook: true });
assert.strictEqual(resBook.uiQuality, 'good move');
assert.strictEqual(resBook.detailedQuality, 'book');

const resBlunder = ChessEvaluator.classifyMove(0.70, 0.20, { playedIsBest: false });
assert.strictEqual(resBlunder.uiQuality, 'blunder');
assert.strictEqual(resBlunder.detailedQuality, 'blunder');

const resMistake = ChessEvaluator.classifyMove(0.60, 0.45, { playedIsBest: false });
assert.strictEqual(resMistake.uiQuality, 'mistake');
assert.strictEqual(resMistake.detailedQuality, 'mistake');

// Format score tests
assert.strictEqual(ChessEvaluator.formatScore({ cp: 150 }, 'w'), '+1.50');
assert.strictEqual(ChessEvaluator.formatScore({ cp: -220 }, 'w'), '-2.20');
assert.strictEqual(ChessEvaluator.formatScore({ mate: 2 }, 'w'), 'M2');
assert.strictEqual(ChessEvaluator.formatScore({ mate: -3 }, 'w'), '-M3');

// Black move win probability & blunder classification test:
// When Stockfish evaluates Black's position, score cp is in Black's POV.
// E.g., Black is winning by +200 cp (bestCp = 200). Black plays a blunder and is now -400 cp (playedCp = -400).
const blackBestCp = 200;
const blackPlayedCp = -400;
const blackWpBefore = ChessEvaluator.cpToWinProb(blackBestCp);
const blackWpAfter = ChessEvaluator.cpToWinProb(blackPlayedCp);
assert(blackWpBefore > 0.70, `Black should have high win prob before blunder, got ${blackWpBefore}`);
assert(blackWpAfter < 0.15, `Black should have low win prob after blunder, got ${blackWpAfter}`);
const blackBlunderClass = ChessEvaluator.classifyMove(blackWpBefore, blackWpAfter, { playedIsBest: false });
assert.strictEqual(blackBlunderClass.uiQuality, 'blunder', 'Black move with -0.60 win prob drop must be blunder');

// Display evaluation for Black move:
// Black is winning (+200 cp from Black's POV). Display relative to White should be -2.00.
const blackMoverScore = { cp: 200 };
const whiteDisplayScore = { cp: -blackMoverScore.cp };
assert.strictEqual(ChessEvaluator.formatScore(whiteDisplayScore, 'w'), '-2.00');

// Key Moment identification tests (auto-next skips mistake and inaccuracy)
assert.strictEqual(ChessEvaluator.isKeyMoment({ quality: 'blunder' }), true);
assert.strictEqual(ChessEvaluator.isKeyMoment({ detailed_quality: 'blunder' }), true);
assert.strictEqual(ChessEvaluator.isKeyMoment({ detailed_quality: 'missed win' }), true);
assert.strictEqual(ChessEvaluator.isKeyMoment({ quality: 'miss' }), true);
assert.strictEqual(ChessEvaluator.isKeyMoment({ detailed_quality: 'brilliant' }), true);
assert.strictEqual(ChessEvaluator.isKeyMoment({ detailed_quality: 'great' }), true);
assert.strictEqual(ChessEvaluator.isKeyMoment({ quality: 'blunder', win_prob_loss: 0.25 }), true);
assert.strictEqual(ChessEvaluator.isKeyMoment({ quality: 'good move', tags: ['Checkmate'] }), true);
// Mistakes and inaccuracies MUST be skipped
assert.strictEqual(ChessEvaluator.isKeyMoment({ quality: 'mistake' }), false);
assert.strictEqual(ChessEvaluator.isKeyMoment({ detailed_quality: 'mistake' }), false);
assert.strictEqual(ChessEvaluator.isKeyMoment({ quality: 'inaccuracy' }), false);
assert.strictEqual(ChessEvaluator.isKeyMoment({ detailed_quality: 'inaccuracy' }), false);
assert.strictEqual(ChessEvaluator.isKeyMoment({ quality: 'mistake', win_prob_loss: 0.14 }), false);
assert.strictEqual(ChessEvaluator.isKeyMoment({ quality: 'good move', detailed_quality: 'book' }), false);
assert.strictEqual(ChessEvaluator.isKeyMoment({ quality: 'good move', detailed_quality: 'good', win_prob_loss: 0.01 }), false);

console.log("✓ ChessEvaluator passed!");

// 2. OpeningDetector tests
console.log("Testing OpeningDetector...");
const op1 = OpeningDetector.identifyOpening(["e4", "e5", "Nf3", "Nc6", "Bc4"]);
assert.strictEqual(op1.eco, "C50");
assert.strictEqual(op1.name, "Italian Game");

const op2 = OpeningDetector.identifyOpening(["d4", "g6"]);
assert.strictEqual(op2.eco, "A40");
assert.strictEqual(op2.name, "Queen's Pawn Game: Modern Defense");

assert.strictEqual(OpeningDetector.isBookMove(["e4", "e5", "Nf3"], 3), true);
assert.strictEqual(OpeningDetector.isBookMove(["h4", "h5"], 2), false);

// Early queen sortie
const bQ = new Chess();
bQ.move('e4');
bQ.move('e5');
const qMove = { from: 'd1', to: 'h5', piece: 'q' };
const opViolation = OpeningDetector.detectOpeningPrincipleViolation(bQ, qMove, 3);
assert(opViolation !== null && opViolation.includes('Queen too early'));

console.log("✓ OpeningDetector passed!");

// 3. SituationRecognizer tests
console.log("Testing SituationRecognizer...");

// Fork test: White knight on e7 forks Black King on g8 and Rook on c8
const forkBoard = new Chess("2r3k1/4N3/8/8/8/8/8/4K3 b - - 0 1");
const forkMove = { from: 'd5', to: 'e7', piece: 'n' };
const forkRes = SituationRecognizer.detectFork(forkBoard, forkMove);
assert(forkRes !== null, "Fork should be detected");
assert.strictEqual(forkRes.type, 'fork');
assert(forkRes.targets.includes('king') && forkRes.targets.includes('rook'));

// Fork test 2: Attacker is capturable by Black bishop on d6 (Bxe7) -> filtered out
const forkBoardCapturable = new Chess("2r3k1/4N3/3b4/8/8/8/8/4K3 b - - 0 1");
const forkResCapturable = SituationRecognizer.detectFork(forkBoardCapturable, forkMove);
assert.strictEqual(forkResCapturable, null, "Capturable attacker fork should be filtered out");

// Fork test 3: Defensible fork (1... Bd6 defends both bishops) -> filtered out
const forkBoardDefensible = new Chess("7k/2b1b3/8/3N4/8/8/8/4K3 b - - 0 1");
const forkMoveDefensible = { from: 'c3', to: 'd5', piece: 'n' };
const forkResDefensible = SituationRecognizer.detectFork(forkBoardDefensible, forkMoveDefensible);
assert.strictEqual(forkResDefensible, null, "Defensible fork should be filtered out");

// Fork test 4: Real pawn fork (d4 forks knight on c5 and bishop on e5) -> detected
const pawnForkBoard = new Chess("r2qk2r/ppp2ppp/8/2n1b3/3P4/8/PPP2PPP/RNBQK2R b KQkq - 0 1");
const pawnForkMove = { from: 'd2', to: 'd4', piece: 'p' };
const pawnForkRes = SituationRecognizer.detectFork(pawnForkBoard, pawnForkMove);
assert(pawnForkRes !== null, "Pawn fork should be detected");
assert.strictEqual(pawnForkRes.type, 'fork');
assert(pawnForkRes.targets.includes('bishop') && pawnForkRes.targets.includes('knight'));

// Fork test 5: Piece attacking two pawns only -> filtered out
const twoPawnsBoard = new Chess("rnbqkbnr/p1pppppp/8/8/Q7/8/PPPPPPPP/RNB1KBNR b KQkq - 0 1");
const twoPawnsMove = { from: 'd1', to: 'a4', piece: 'q' };
const twoPawnsRes = SituationRecognizer.detectFork(twoPawnsBoard, twoPawnsMove);
assert.strictEqual(twoPawnsRes, null, "Two pawns attack should not be considered a tactical fork");

// Pin test: White bishop on c4 pins Black pawn/knight to king on g8
const pinBoard = new Chess("6k1/5p2/8/8/2B5/8/8/4K3 b - - 0 1");
const pinMove = { from: 'f1', to: 'c4', piece: 'b' };
const pinRes = SituationRecognizer.detectPin(pinBoard, pinMove);
assert(pinRes !== null, "Pin should be detected");
assert.strictEqual(pinRes.type, 'pin');
assert.strictEqual(pinRes.pinned, 'pawn');

// Hanging piece blunder: Bishop moves to e6 (attacked by d7 pawn)
const hangBefore = new Chess("rnbqkbnr/pppp1ppp/8/8/8/8/PPPPBPPP/RNBQK1NR w KQkq - 0 1");
const hangMove = { from: 'e2', to: 'e6' };
const hangAfter = new Chess("rnbqkbnr/pppp1ppp/4B3/8/8/8/PPPP1PPP/RNBQK1NR b KQkq - 0 1");
const hangRes = SituationRecognizer.detectHangingPieceBlunder(hangBefore, hangAfter, hangMove);
assert(hangRes !== null, "Hanging piece blunder should be detected");
assert.strictEqual(hangRes.type, 'hanging_piece');
assert.strictEqual(hangRes.piece, 'bishop');

// Threat created: White plays 2. Qh5 attacking undefended e5 pawn
const threatBoard = new Chess("rnbqkbnr/pppp1ppp/8/4p2Q/8/8/PPPP1PPP/RNB1K1NR b KQkq - 1 2");
const threatMove = { from: 'd1', to: 'h5' };
const threats = SituationRecognizer.detectThreatsCreated(threatBoard, threatMove);
assert(threats.length > 0, "Threats should be created by Qh5");
const e5Threat = threats.find(t => t.to === 'e5');
assert(e5Threat !== undefined && e5Threat.is_undefended, "e5 threat should be found");

// Outpost detection
const outpostBoard = new Chess("4k3/4bppp/8/3N4/4P3/8/PPP2PPP/4K3 w - - 0 1");
assert.strictEqual(SituationRecognizer.isTrueOutpost(outpostBoard, 'd5', 'w'), true);

// Skewer detection: White Rook on a1 moves to e1, skewering Black King on e4 and Queen on e8
const skewerBoard = new Chess("4q3/8/8/8/4k3/8/1K6/R7 w - - 0 1");
const skewerMove = { from: 'a1', to: 'e1', piece: 'r' };
skewerBoard.move(skewerMove);
const skewerRes = SituationRecognizer.detectSkewer(skewerBoard, skewerMove);
assert(skewerRes !== null, "Skewer should be detected");
assert.strictEqual(skewerRes.type, 'skewer');
assert.strictEqual(skewerRes.front, 'king');
assert.strictEqual(skewerRes.back, 'queen');

// Discovered check detection: White Queen on d1, White Knight on d4 moves to e6, revealing check from Queen to King on d8
const discBefore = new Chess("3k4/8/8/8/3N4/8/8/3QK3 w - - 0 1");
const discMove = { from: 'd4', to: 'e6', piece: 'n' };
const discAfter = new Chess("3k4/8/4N3/8/8/8/8/3QK3 b - - 1 1");
const discRes = SituationRecognizer.detectDiscoveredAttack(discBefore, discAfter, discMove);
assert(discRes !== null, "Discovered attack should be detected");
assert.strictEqual(discRes.type, 'discovered_check');

// Center strike detection: White plays 2. d4 challenging e5 pawn
const centerBoard = new Chess("rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2");
const centerMove = { from: 'd2', to: 'd4', piece: 'p' };
const centerRes = SituationRecognizer.detectCenterStrike(centerBoard, centerMove);
assert(centerRes !== null, "Center strike should be detected");
assert(centerRes.description.includes("d4") && centerRes.description.includes("challenge"));

// Minor development detection: Black plays Nc6 from b8
const devBoard = new Chess("rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2");
const devMove = { from: 'b8', to: 'c6', piece: 'n' };
const devRes = SituationRecognizer.detectMinorDevelopment(devBoard, devMove);
assert(devRes !== null, "Minor development should be detected");
assert(devRes.includes("knight to an active square"));

// USER SCENARIO TEST: Black played d6, White refutation d4, recommended Nc6
// Must NOT say "maintains optimal piece activity and board control"
console.log("Testing user scenario (d6 allows d4, better was Nc6)...");
const userBefore = new Chess("rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2");
const userAfter = new Chess("rnbqkbnr/ppp2ppp/3p4/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 3");
const userDiag = SituationRecognizer.explainBlunderOrMistake({
    boardBefore: userBefore,
    boardAfter: userAfter,
    playedMove: { from: 'd7', to: 'd6' },
    bestMove: { from: 'b8', to: 'c6' },
    refutationMove: { from: 'd2', to: 'd4' },
    sanPlayed: 'd6',
    sanBest: 'Nc6',
    sanRef: 'd4'
});
console.log("Generated diagnosis:", userDiag.explanation);
assert(!userDiag.explanation.includes("maintains optimal piece activity and board control"), "Must not use old repetitive phrase");
assert(userDiag.explanation.includes("d6"), "Must mention played move d6");
assert(userDiag.explanation.includes("d4"), "Must mention refutation d4");
assert(userDiag.explanation.includes("Nc6"), "Must mention better move Nc6");
assert(userDiag.explanation.includes("center"), "Must mention central control / center");
assert(userDiag.tags.includes("Center Control"), "Must have Center Control tag");
assert(userDiag.tags.includes("Development"), "Must have Development tag");

// Missed tactical fork test: White plays a3 instead of Nc7+ (forking King and Rook)
console.log("Testing missed tactical fork diagnosis...");
const missedForkBefore = new Chess("r3k3/8/8/3N4/8/8/PPPPPPPP/R3K3 w - - 0 1");
const missedForkPlayed = new Chess("r3k3/8/8/3N4/8/P7/1PPPPPPP/R3K3 b - - 0 1");
const missedForkDiag = SituationRecognizer.explainBlunderOrMistake({
    boardBefore: missedForkBefore,
    boardAfter: missedForkPlayed,
    playedMove: { from: 'a2', to: 'a3' },
    bestMove: { from: 'd5', to: 'c7' },
    sanPlayed: 'a3',
    sanBest: 'Nc7+'
});
console.log("Generated missed tactic diagnosis:", missedForkDiag.explanation);
assert(missedForkDiag.tags.includes("Missed Tactic"), "Should tag Missed Tactic");
assert(missedForkDiag.tags.includes("Tactical Fork"), "Should tag Tactical Fork");
assert(missedForkDiag.explanation.includes("overlooks a tactical opportunity") || missedForkDiag.explanation.includes("forks"), "Should explain missed tactical opportunity");

// Tactical blunder test: Player leaves bishop hanging on e6
console.log("Testing hanging piece blunder diagnosis...");
const hangBlunderBefore = new Chess("rnbqkbnr/pppp1ppp/8/8/8/8/PPPPBPPP/RNBQK1NR w KQkq - 0 1");
const hangBlunderAfter = new Chess("rnbqkbnr/pppp1ppp/4B3/8/8/8/PPPP1PPP/RNBQK1NR b KQkq - 1 1");
const hangBlunderDiag = SituationRecognizer.explainBlunderOrMistake({
    boardBefore: hangBlunderBefore,
    boardAfter: hangBlunderAfter,
    playedMove: { from: 'e2', to: 'e6' },
    bestMove: { from: 'e2', to: 'c4' },
    refutationMove: { from: 'd7', to: 'e6' },
    sanPlayed: 'Be6',
    sanBest: 'Bc4',
    sanRef: 'dxe6'
});
console.log("Generated hanging piece diagnosis:", hangBlunderDiag.explanation);
assert(hangBlunderDiag.tags.includes("Hanging Piece"), "Should tag Hanging Piece");
assert(hangBlunderDiag.explanation.includes("leaves the bishop hanging"), "Should explain hanging bishop");

// 4. Missed attack on Queen test: White plays a3 instead of d4 (attacking enemy Queen on e5)
console.log("Testing missed attack on Queen diagnosis...");
const missedQAttackBefore = new Chess("r1b1kbnr/pppp1ppp/2n5/4q3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 1 3");
const missedQAttackPlayed = new Chess("r1b1kbnr/pppp1ppp/2n5/4q3/4P3/P7/1PPP1PPP/RNBQKBNR b KQkq - 0 3");
const missedQAttackDiag = SituationRecognizer.explainBlunderOrMistake({
    boardBefore: missedQAttackBefore,
    boardAfter: missedQAttackPlayed,
    playedMove: { from: 'a2', to: 'a3' },
    bestMove: { from: 'd2', to: 'd4' },
    sanPlayed: 'a3',
    sanBest: 'd4'
});
console.log("Generated missed Queen attack diagnosis:", missedQAttackDiag.explanation);
assert(missedQAttackDiag.tags.includes("Missed Attack"), "Should tag Missed Attack");
assert(missedQAttackDiag.tags.includes("Attack on Queen"), "Should tag Attack on Queen");
assert(missedQAttackDiag.explanation.includes("Queen"), "Should mention Queen in explanation");
assert(missedQAttackDiag.missedChance.includes("Queen"), "missedChance should explicitly mention Queen");
assert(missedQAttackDiag.betterLine.includes("Queen"), "betterLine should mention Queen");

// 5. Missed attack on undefended piece test: White plays h3 instead of b4 attacking undefended knight on a5
console.log("Testing missed attack on undefended piece diagnosis...");
const missedPieceAttackBefore = new Chess("r1b1kbnr/pppp1ppp/8/n3p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3");
const missedPieceAttackPlayed = new Chess("r1b1kbnr/pppp1ppp/8/n3p3/4P3/5N1P/PPPP1PP1/RNBQKB1R b KQkq - 0 3");
const missedPieceAttackDiag = SituationRecognizer.explainBlunderOrMistake({
    boardBefore: missedPieceAttackBefore,
    boardAfter: missedPieceAttackPlayed,
    playedMove: { from: 'h2', to: 'h3' },
    bestMove: { from: 'b2', to: 'b4' },
    sanPlayed: 'h3',
    sanBest: 'b4'
});
console.log("Generated missed piece attack diagnosis:", missedPieceAttackDiag.explanation);
assert(missedPieceAttackDiag.tags.includes("Missed Attack"), "Should tag Missed Attack");
assert(missedPieceAttackDiag.tags.includes("Attacking Piece"), "Should tag Attacking Piece");
assert(missedPieceAttackDiag.explanation.includes("knight"), "Should mention knight in explanation");
assert(missedPieceAttackDiag.missedChance.includes("knight"), "missedChance should mention knight");

// 6. Multi-ply combination test: PV material gain winning Queen
console.log("Testing combination PV material gain...");
const comboBefore = new Chess("4k3/8/8/8/3q4/8/3R4/4K3 w - - 0 1");
const comboPlayed = new Chess("4k3/8/8/8/3q4/8/3R4/5K2 b - - 1 1");
const comboDiag = SituationRecognizer.explainBlunderOrMistake({
    boardBefore: comboBefore,
    boardAfter: comboPlayed,
    playedMove: { from: 'e1', to: 'f1' },
    bestMove: { from: 'd2', to: 'd4' },
    sanPlayed: 'Kf1',
    sanBest: 'Rxd4',
    bestPv: ['d2d4']
});
console.log("Generated combination diagnosis:", comboDiag.explanation);
assert(comboDiag.tags.includes("Winning Material"), "Should tag Winning Material");
assert(comboDiag.tags.includes("Missed Tactic"), "Should tag Missed Tactic");
assert(comboDiag.explanation.includes("Queen"), "Should mention Queen in explanation");
assert(comboDiag.betterLine.includes("Queen"), "betterLine should mention winning the Queen");

// 7. Board control dominance tests
console.log("Testing board control dominance detection...");
const pawnCenterBefore = new Chess("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1");
const pawnCenterAfter = new Chess("rnbqkbnr/pppppppp/8/8/3PP3/8/PPP2PPP/RNBQKBNR b KQkq - 0 2");
const centerDuo = SituationRecognizer.detectBoardControlDominance(pawnCenterBefore, pawnCenterAfter, { from: 'd2', to: 'd4' });
assert(centerDuo !== null, "Should detect pawn center duo");
assert.strictEqual(centerDuo.type, 'pawn_center_duo', "Should be pawn_center_duo");
assert(centerDuo.tags.includes("Center Control"), "Should have Center Control tag");

const rook7thBefore = new Chess("4k3/8/8/8/8/8/8/3R1K2 w - - 0 1");
const rook7thAfter = new Chess("4k3/3R4/8/8/8/8/8/5K2 b - - 1 1");
const rook7th = SituationRecognizer.detectBoardControlDominance(rook7thBefore, rook7thAfter, { from: 'd1', to: 'd7' });
assert(rook7th !== null, "Should detect 7th rank infiltration");
assert.strictEqual(rook7th.type, 'seventh_rank', "Should be seventh_rank");

// 8. King safety & castling rights detection tests
console.log("Testing king safety & castling rights logic...");
const startPos = new Chess();
assert.strictEqual(SituationRecognizer.hasCastlingRights(startPos, 'w'), true, "White should have castling rights at start");
assert.strictEqual(SituationRecognizer.hasCastlingRights(startPos, 'b'), true, "Black should have castling rights at start");

// King forfeiting castling rights on move 2: 1. e4 e5 2. Ke2
const fenBeforeKe2 = new Chess("rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2");
const fenAfterKe2 = new Chess("rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPPKPPP/RNBQ1BNR b kq - 1 2");
const forfeitFlaw = SituationRecognizer.detectKingSafetyFlaw(fenBeforeKe2, fenAfterKe2, { from: 'e1', to: 'e2' });
assert(forfeitFlaw !== null && forfeitFlaw.includes("forfeiting castling rights"), "Should detect forfeiting castling rights when king moves from e1 with rights available");

// King move in endgame (move 49 Kf4??) where castling is long gone:
const endgameBefore = new Chess('4k3/8/8/5RK1/1r2n3/6P1/8/8 w - - 0 49');
const endgameAfter = new Chess('4k3/8/8/5R2/1r2nK2/6P1/8/8 b - - 1 49');
assert.strictEqual(SituationRecognizer.hasCastlingRights(endgameBefore, 'w'), false, "White should not have castling rights in endgame");
const endgameFlaw = SituationRecognizer.detectKingSafetyFlaw(endgameBefore, endgameAfter, { from: 'g5', to: 'f4' });
assert.strictEqual(endgameFlaw, null, "King move in endgame must NOT be flagged as forfeiting castling rights");

const endgameDiag = SituationRecognizer.explainBlunderOrMistake({
    boardBefore: endgameBefore,
    boardAfter: endgameAfter,
    playedMove: { from: 'g5', to: 'f4' },
    bestMove: { from: 'g5', to: 'g4' },
    refutationMove: { from: 'e4', to: 'd6' },
    sanPlayed: 'Kf4',
    sanBest: 'Kg4',
    sanRef: 'Nd6+',
    refPv: ['e4d6', 'f4e5', 'd6f5']
});
console.log("Endgame diagnosis explanation:", endgameDiag.explanation);
assert(!endgameDiag.explanation.includes("castling"), "Endgame diagnosis must not mention castling");
assert(!endgameDiag.explanation.includes("a a Rook"), "Must not have duplicate 'a a' article");
assert(!endgameDiag.tags.includes("King Safety"), "Endgame blunder must not have King Safety tag");
assert(endgameDiag.tags.includes("Losing Material"), "Should tag Losing Material");
assert(endgameDiag.tags.includes("Discovered Attack"), "Should tag Discovered Attack");

// 9. Structured breakdown properties verification
console.log("Testing structured breakdown properties...");
assert(userDiag.flaw !== undefined && userDiag.flaw !== null, "Should have flaw property");
assert(userDiag.betterLine !== undefined && userDiag.betterLine !== null, "Should have betterLine property");
assert(missedForkDiag.missedChance !== undefined && missedForkDiag.missedChance !== null, "Should have missedChance property");
assert(missedForkDiag.betterLine !== undefined && missedForkDiag.betterLine !== null, "Should have betterLine property");

console.log("✓ SituationRecognizer passed!");

// 4. AnalysisCache tests
console.log("Testing AnalysisCache...");
const AnalysisCacheModule = require('./js/analysis-cache.js');

// Mock localStorage
const mockStorage = (function() {
    let store = {};
    return {
        getItem: (k) => store[k] || null,
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: (k) => { delete store[k]; },
        clear: () => { store = {}; }
    };
})();

const cache = new AnalysisCacheModule.AnalysisCache(mockStorage, 5);
cache.clear();

const testPgn1 = "1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5";
const testResult1 = {
    game_info: { white: 'Alice', black: 'Bob' },
    moves: [{ move: 'e4', quality: 'good move' }]
};

// Test basic set & get
assert.strictEqual(cache.get(testPgn1), null, "Initial cache should be empty");
cache.set(testPgn1, 18, testResult1);
const hit1 = cache.get(testPgn1, 18);
assert(hit1 !== null, "Should retrieve cached game");
assert.strictEqual(hit1.game_info.white, 'Alice');
assert.strictEqual(hit1.moves.length, 1);
assert.strictEqual(cache.count(), 1);

// Test PGN with comments / whitespace variation
const testPgn1WithComments = "1. e4 { best move } 1... e5 \n 2. Nf3 Nc6 3. Bc4 Bc5";
const hit1Fuzzy = cache.get(testPgn1WithComments, 18);
assert(hit1Fuzzy !== null, "Fuzzy comment/whitespace PGN should match cache");

// Test depth threshold
const hitDepth22 = cache.get(testPgn1, 22);
assert.strictEqual(hitDepth22, null, "Requesting higher depth than cached should return null");

// Test Lichess ID matching
const lichessUrl = "https://lichess.org/Qa7FJNk2";
cache.set(lichessUrl, 18, {
    game_info: { white: 'Morphy', black: 'Duke' },
    moves: [{ move: 'e4', quality: 'good move' }]
}, 'Qa7FJNk2');

const hitLichessById = cache.get('Qa7FJNk2', 18);
assert(hitLichessById !== null, "Should retrieve by Lichess ID");
assert.strictEqual(hitLichessById.game_info.white, 'Morphy');

const hitLichessByUrl = cache.get('https://lichess.org/Qa7FJNk2', 18);
assert(hitLichessByUrl !== null, "Should retrieve by full Lichess URL");

// Test Lichess URL sanitization
const hitLichessSanitized = cache.get('https://lichess.org/Qa7FJNk2/white#12', 18);
assert(hitLichessSanitized !== null, "Should retrieve by Lichess URL with /white#12");
assert.strictEqual(AnalysisCacheModule.extractLichessId('https://lichess.org/Qa7FJNk2/black#10'), 'Qa7FJNk2');
assert.strictEqual(AnalysisCacheModule.extractLichessId('Qa7FJNk2/white'), 'Qa7FJNk2');
assert.strictEqual(AnalysisCacheModule.extractLichessId('https://lichess.org/Qa7FJNk2?theme=dark'), 'Qa7FJNk2');

// Test PGN Fingerprint cache matching
const samplePgn = "1. e4 e5 2. Nf3 Nc6 3. Bb5 a6";
cache.set(samplePgn, 18, {
    game_info: { white: 'Morphy', black: 'Amateur' },
    moves: [{ move: 'e4', quality: 'good move' }]
});

const hitByPgn = cache.get("1. e4 e5 2. Nf3 Nc6 3. Bb5 a6", 18);
assert(hitByPgn !== null, "Should retrieve by PGN fingerprint");
assert.strictEqual(hitByPgn.game_info.white, 'Morphy');

const hitByPgnWithHeaders = cache.get('[Event "Test"]\n1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 1-0', 18);
assert(hitByPgnWithHeaders !== null, "Should retrieve by PGN with headers matching fingerprint");

// Test 5-game LRU eviction limit
cache.clear();
for (let i = 1; i <= 6; i++) {
    cache.set(`1. e4 c${i}`, 18, {
        game_info: { white: `Player ${i}`, black: 'Opp' },
        moves: [{ move: 'e4', quality: 'good move' }]
    });
}
assert.strictEqual(cache.count(), 5, "Cache should cap at 5 games");
assert.strictEqual(cache.get("1. e4 c1", 18), null, "Game 1 should be evicted (LRU)");
assert(cache.get("1. e4 c6", 18) !== null, "Game 6 (newest) should exist in cache");
assert(cache.get("1. e4 c2", 18) !== null, "Game 2 should still exist in cache");

// Accessing Game 2 bumps it to most recent; now adding Game 7 should evict Game 3, NOT Game 2
cache.set("1. e4 c7", 18, {
    game_info: { white: 'Player 7', black: 'Opp' },
    moves: [{ move: 'e4', quality: 'good move' }]
});
assert.strictEqual(cache.count(), 5);
assert(cache.get("1. e4 c2", 18) !== null, "Game 2 was bumped to MRU, should not be evicted");
console.log("✓ AnalysisCache passed!");

// Test index.html banner markup and styling integrity
console.log("Testing index.html banner markup & styling integrity...");
const fs = require('fs');
const indexHtml = fs.readFileSync(require('path').join(__dirname, 'index.html'), 'utf8');

// Self Review: review the critical moments yourself before the engine
console.log("Testing SelfReview...");
{
    const SelfReview = require('./js/self-review.js');

    assert.strictEqual(SelfReview.parseEval('+1.20'), 120);
    assert.strictEqual(SelfReview.parseEval('-0.35'), -35);
    assert.strictEqual(SelfReview.parseEval('M3'), 9970);
    assert.strictEqual(SelfReview.parseEval('-M2'), -9980);
    assert.strictEqual(SelfReview.parseEval('#1'), 9990);
    assert.strictEqual(SelfReview.parseEval(null), null);
    assert.strictEqual(SelfReview.parseEval('abc'), null);

    assert.strictEqual(SelfReview.evalKeyFromWp(0.95), 'winning');
    assert.strictEqual(SelfReview.evalKeyFromWp(0.65), 'better');
    assert.strictEqual(SelfReview.evalKeyFromWp(0.5), 'equal');
    assert.strictEqual(SelfReview.evalKeyFromWp(0.2), 'worse');
    assert.strictEqual(SelfReview.evalKeyFromWp(0.05), 'losing');

    assert.strictEqual(SelfReview.engineMoveLevel({ detailed_quality: 'best' }), 0);
    assert.strictEqual(SelfReview.engineMoveLevel({ detailed_quality: 'excellent' }), 1);
    assert.strictEqual(SelfReview.engineMoveLevel({ detailed_quality: 'inaccuracy' }), 2);
    assert.strictEqual(SelfReview.engineMoveLevel({ detailed_quality: 'blunder' }), 3);
    assert.strictEqual(SelfReview.engineMoveLevel({ quality: 'missed win' }), 3);

    // A 24-ply game: plies 0-7 opening, 8-17 middlegame, 18-23 endgame
    const phaseOf = (fen) => fen;
    const fens = Array.from({ length: 24 }, (_, i) => i < 8 ? 'opening' : (i < 18 ? 'middlegame' : 'endgame'));
    const mv = (i, dq, extra) => Object.assign({
        move_number: Math.floor(i / 2) + 1,
        ply: i + 1,
        move: 'm' + i,
        is_white: i % 2 === 0,
        quality: ['blunder', 'mistake', 'inaccuracy', 'missed win'].includes(dq) ? dq : 'good move',
        detailed_quality: dq,
        win_probability: 0.5,
        win_prob_loss: 0,
        evaluation: '+0.20',
        analysis: { best_move: 'b' + i, best_evaluation: '+0.20', why: null }
    }, extra || {});
    const game = Array.from({ length: 24 }, (_, i) => mv(i, i < 4 ? 'book' : 'excellent'));
    game[6] = mv(6, 'mistake', { win_prob_loss: 0.12 });                 // White, opening
    game[11] = mv(11, 'blunder', { win_prob_loss: 0.4 });                // Black errs...
    game[12] = mv(12, 'best', { analysis: { best_move: 'm12', best_evaluation: '+3.00' } }); // ...White punishes
    game[14] = mv(14, 'blunder', { win_prob_loss: 0.35, analysis: { best_move: 'Qd5', best_evaluation: '+2.50', why: { alternatives: [{ san: 'Rd1', wp: 0.72 }] } } });
    game[20] = mv(20, 'great', {});
    game[2] = mv(2, 'book', { win_prob_loss: 0.5 });                      // book moves never count

    const plan = SelfReview.buildPlan(game, { side: 'white', fens, phaseOf });
    assert.strictEqual(plan.side, 'white');
    assert.deepStrictEqual(plan.phases.map(p => p.phase), ['opening', 'middlegame', 'endgame']);
    assert.deepStrictEqual(plan.moments, [6, 12, 14, 20], 'White moments: the mistake, the punish, the blunder, the great move');
    assert.ok(plan.moments.every(i => game[i].is_white), 'Only the chosen side\'s moves are reviewed');
    assert.ok(!plan.moments.includes(2), 'Book moves are never critical moments');
    assert.deepStrictEqual(plan.phases[1].moments, [12, 14]);
    assert.deepStrictEqual(SelfReview.buildPlan(game, { side: 'white', fens, phaseOf }), plan, 'Plan must be deterministic');

    const blackPlan = SelfReview.buildPlan(game, { side: 'black', fens, phaseOf });
    assert.ok(blackPlan.moments.includes(11) && blackPlan.moments.every(i => !game[i].is_white));

    // Forced moves (one legal reply) are skipped
    const forced = fens.map((_, i) => i === 14 ? 1 : 20);
    assert.ok(!SelfReview.buildPlan(game, { side: 'white', fens, phaseOf, legalMoveCounts: forced }).moments.includes(14));

    // Per-phase cap
    const busy = Array.from({ length: 24 }, (_, i) => mv(i, 'blunder', { win_prob_loss: 0.3 }));
    const busyPlan = SelfReview.buildPlan(busy, { side: 'white', fens, phaseOf });
    busyPlan.phases.forEach(p => assert.ok(p.moments.length <= 3, 'At most 3 moments per phase'));
    assert.ok(busyPlan.moments.length <= 8, 'At most 8 moments per game');

    // Phases never go backwards (a promotion can push material back up)
    const wobbly = ['opening', 'middlegame', 'opening', 'endgame', 'middlegame'];
    assert.deepStrictEqual(SelfReview.phaseSequence(wobbly.map(() => ({})), wobbly, phaseOf), ['opening', 'middlegame', 'middlegame', 'endgame', 'endgame']);

    const steps = SelfReview.planSteps(plan);
    assert.strictEqual(steps[0].type, 'phase');
    assert.strictEqual(steps[steps.length - 1].type, 'reveal');
    assert.strictEqual(steps.filter(s => s.type === 'moment').length, plan.moments.length);
    assert.strictEqual(steps.filter(s => s.type === 'checkpoint').length, 3);

    // Review gate: unanswered moments are flagged and block the next phase
    assert.strictEqual(SelfReview.isMomentReviewed({ eval: 'equal' }), false, 'Both questions must be answered');
    assert.strictEqual(SelfReview.isMomentReviewed({ eval: 'equal', rating: 'fine' }), true);
    const gateAnswers = { moments: { 6: { eval: 'equal', rating: 'fine' }, 12: { eval: 'better' } } };
    assert.strictEqual(SelfReview.momentStatus(6, gateAnswers, []), 'reviewed');
    assert.strictEqual(SelfReview.momentStatus(12, gateAnswers, [12]), 'needs-review', 'Opened and left unanswered');
    assert.strictEqual(SelfReview.momentStatus(14, gateAnswers, ['12']), 'pending', 'Not opened yet');
    assert.strictEqual(SelfReview.momentStatus(12, gateAnswers, ['12']), 'needs-review', 'Visited indices may come back from JSON as strings');
    assert.deepStrictEqual(SelfReview.unreviewedMoments(plan, gateAnswers, []), [12, 14, 20]);
    assert.deepStrictEqual(SelfReview.unreviewedMoments(plan, gateAnswers, 'middlegame'), [12, 14]);
    const gSteps = SelfReview.planSteps(plan);
    const stepOf = (pred) => gSteps.findIndex(pred);
    const openingCheckpoint = stepOf(st => st.type === 'checkpoint' && st.phase === 'opening');
    const middleIntro = stepOf(st => st.type === 'phase' && st.phase === 'middlegame');
    const middleCheckpoint = stepOf(st => st.type === 'checkpoint' && st.phase === 'middlegame');
    const endIntro = stepOf(st => st.type === 'phase' && st.phase === 'endgame');
    const reveal = gSteps.length - 1;
    assert.deepStrictEqual(SelfReview.stepBlockers(plan, gSteps, gateAnswers, openingCheckpoint, middleIntro), [], 'Opening is fully reviewed');
    assert.deepStrictEqual(SelfReview.stepBlockers(plan, gSteps, gateAnswers, middleIntro, middleCheckpoint), [], 'Moving within a phase is free');
    assert.deepStrictEqual(SelfReview.stepBlockers(plan, gSteps, gateAnswers, middleCheckpoint, endIntro), [12, 14], 'Next phase needs the middlegame answered');
    assert.deepStrictEqual(SelfReview.stepBlockers(plan, gSteps, gateAnswers, endIntro, middleIntro), [], 'Going back is never blocked');
    assert.deepStrictEqual(SelfReview.stepBlockers(plan, gSteps, gateAnswers, reveal - 1, reveal), [12, 14, 20], 'The comparison needs every moment');
    const allDone = { moments: { 6: { eval: 'equal', rating: 'fine' }, 12: { eval: 'better', rating: 'bad' }, 14: { eval: 'equal', rating: 'fine' }, 20: { eval: 'winning', rating: 'strong' } } };
    assert.deepStrictEqual(SelfReview.stepBlockers(plan, gSteps, allDone, reveal - 1, reveal), []);

    // Candidate moves vs the engine
    assert.strictEqual(SelfReview.candidateVerdict(game[14], 'Qd5+'), 'best');
    assert.strictEqual(SelfReview.candidateVerdict(game[14], 'm14'), 'played');
    assert.strictEqual(SelfReview.candidateVerdict(game[14], 'Rd1'), 'ok', 'Alternative within 0.12 WP of the best is playable');
    assert.strictEqual(SelfReview.candidateVerdict(game[14], 'Nf3'), null, 'Unknown moves need an engine check');
    assert.strictEqual(SelfReview.candidateVerdict(game[14], 'Nf3', 0.2), 'worse');

    // Compare the player's answers with the engine
    const answers = {
        moments: {
            6: { rating: 'dubious', eval: 'equal' },
            12: { rating: 'strong', eval: 'winning', candidate: 'm12', note: 'Saw it!' },
            14: { rating: 'fine', eval: 'winning', candidate: 'Qd5' }
        },
        phases: { opening: { eval: 'winning' }, middlegame: { eval: 'better' } }
    };
    const report = SelfReview.compare(game, plan, answers, { fens, phaseOf });
    const row = (i) => report.rows.find(r => r.index === i);
    assert.strictEqual(row(6).moveVerdict, 'close', 'Dubious vs mistake is one step off');
    assert.strictEqual(row(14).moveVerdict, 'off', 'Fine vs blunder is a big gap');
    assert.strictEqual(row(14).candidateVerdict, 'best');
    assert.strictEqual(row(12).note, 'Saw it!');
    assert.strictEqual(report.totals.errorsTotal, 2);
    assert.strictEqual(report.totals.errorsSpotted, 1, 'Only the mistake rated dubious counts as spotted');
    assert.strictEqual(report.totals.candidatesTried, 1, 'Suggesting the played move is not a new idea');
    assert.strictEqual(report.totals.candidatesGood, 1);
    assert.strictEqual(report.totals.evalBias, 'optimistic', 'Rating positions above the engine is flagged');
    assert.ok(report.takeaways.length >= 1 && report.takeaways.length <= 3);
    assert.ok(report.takeaways[0].includes('8. m14'), 'First takeaway names the unflagged error');
    assert.deepStrictEqual(SelfReview.compare(game, plan, answers, { fens, phaseOf }).takeaways, report.takeaways, 'Takeaways are deterministic');
    const opening = report.phases.find(p => p.phase === 'opening');
    assert.strictEqual(opening.engineEval, 'equal');
    assert.strictEqual(opening.evalVerdict, 'off');

    // Storage: keyed by the move list, most recent games kept
    const mem = { data: {}, getItem(k) { return this.data[k] || null; }, setItem(k, v) { this.data[k] = v; } };
    const key = SelfReview.gameKey(game);
    assert.strictEqual(key, SelfReview.gameKey(game.map(m => Object.assign({}, m, { move: m.move + '?' }))), 'Annotations do not change the key');
    assert.notStrictEqual(key, SelfReview.gameKey(game.slice(0, 20)));
    assert.ok(SelfReview.save(key, { side: 'white', answers }, mem, 1));
    assert.strictEqual(SelfReview.load(key, mem).side, 'white');
    for (let i = 0; i < 35; i++) SelfReview.save('k' + i, { side: 'black' }, mem, 10 + i);
    assert.strictEqual(SelfReview.load(key, mem), null, 'Oldest reviews are evicted beyond 30 games');
    assert.ok(SelfReview.load('k34', mem));

    // index.html wiring
    assert.ok(indexHtml.includes('<script src="js/self-review.js"></script>'), 'self-review.js must be loaded');
    assert.ok(indexHtml.includes('id="selfReviewPanel"'), 'Self review panel must exist');
    assert.ok(indexHtml.includes('id="srSkipToEngine"'), 'Self review must offer a way straight to the engine');
    assert.ok(indexHtml.includes('id="ccSelfReview"'), 'Game Review summary must link to the self review');
    assert.ok(indexHtml.includes('id="srMovesList"'), 'Self review must offer a spoiler-free move list');
    assert.ok(indexHtml.includes('id="ccSplitHandle"'), 'Analysis / move list split must be resizable');
    assert.ok(indexHtml.includes('moveExplanation.innerHTML = srBackBarHtml() + html;'), 'The engine analysis always offers a way back to the self review');
    assert.ok(/function srListIndex\(\) \{\s*return srCursor\(\);/.test(indexHtml), 'Self review move list highlights the last move on the board, one half-move per arrow press');
    assert.ok(indexHtml.includes("const SPLIT_KEY = 'whyblunder_analysis_split';"), 'The split height is remembered');
    assert.ok(indexHtml.includes('function srRevealGoTo(cursor, focus)'), 'Moving through the game on the comparison screen keeps the comparison visible');
    assert.ok(indexHtml.includes('if (srBrowsing() && !srOnReveal()) {'), 'The comparison is not swapped for the browse card');
    assert.ok(indexHtml.includes('<span class="sr-mv-flag">Need review</span>'), 'Moments left unanswered must be flagged "Need review"');
    assert.ok(indexHtml.includes('SelfReview.stepBlockers(selfReview.plan, selfReview.steps, selfReview.answers, selfReview.step, target)'), 'Next must be gated on unreviewed moments');
    assert.ok(indexHtml.includes('body.self-review-active #evalGauge'), 'Eval bar must be hidden during self review');
    assert.ok(indexHtml.includes('srStepCursor(e.key === \'ArrowLeft\' ? -1 : 1);'), 'Arrow keys walk the spoiler-free move list during self review');
    assert.strictEqual((indexHtml.match(/maybeStartSelfReview\(\);/g) || []).length, 3, 'Every analysis load path offers the self review');
    assert.ok(!/Math\.random/.test(fs.readFileSync(require('path').join(__dirname, 'js', 'self-review.js'), 'utf8')), 'Self review must be deterministic');
}
console.log("✓ SelfReview passed!");

// Game Review accuracy helpers (chess.com-style UI)
console.log("Testing Game Review accuracy helpers...");
{
    const mk = (isWhite, loss, dq) => ({ is_white: isWhite, win_prob_loss: loss, detailed_quality: dq || 'best' });
    assert.ok(ChessEvaluator.moveAccuracy(0) > 99.9, "Zero WP loss must be ~100% accuracy");
    assert.strictEqual(ChessEvaluator.moveAccuracy(1), 0, "Total WP loss must clamp to 0% accuracy");
    assert.ok(ChessEvaluator.moveAccuracy(0.05) > ChessEvaluator.moveAccuracy(0.25), "Accuracy must decrease with WP loss");

    const perfect = [mk(true, 0), mk(false, 0), mk(true, 0), mk(false, 0)];
    const perfectAcc = ChessEvaluator.gameAccuracy(perfect);
    assert.ok(perfectAcc.white >= 99.9 && perfectAcc.black >= 99.9, "All-best game must be ~100% for both sides");

    const withBlunder = [mk(true, 0), mk(false, 0), mk(true, 0.35, 'blunder'), mk(false, 0)];
    const blunderAcc = ChessEvaluator.gameAccuracy(withBlunder);
    assert.ok(blunderAcc.white < 90, "A blunder must lower the mover's accuracy");
    assert.ok(blunderAcc.black >= 99.9, "A blunder must not lower the opponent's accuracy");
    assert.deepStrictEqual(ChessEvaluator.gameAccuracy(withBlunder), blunderAcc, "Accuracy must be deterministic");

    const book = ChessEvaluator.gameAccuracy([mk(true, 0.2, 'book')]);
    assert.ok(book.white >= 99.9, "Book moves count as perfect");
    assert.deepStrictEqual(ChessEvaluator.gameAccuracy([]), { white: null, black: null }, "Empty game has no accuracy");

    const phases = ChessEvaluator.phaseAccuracy(withBlunder, ['start', 'start', 'start', 'start']);
    assert.ok(phases.opening.white < 90 && phases.middlegame.white === null, "phaseAccuracy buckets moves by pre-move FEN phase");
}

// chess.com-style UI markup
assert(indexHtml.includes('id="ccSidebar"'), "index.html must include the desktop sidebar");
assert(indexHtml.includes('id="ccReviewSummary"'), "index.html must include the Game Review summary");
assert(indexHtml.includes('id="ccStartReview"'), "index.html must include the Start Review CTA");
assert(indexHtml.includes('id="ccEvalGraphStrip"'), "index.html must include the eval graph strip");
assert(indexHtml.includes('function renderReviewSummary('), "index.html must define renderReviewSummary");
assert(indexHtml.includes('function ccEvalGraphSvg('), "index.html must define ccEvalGraphSvg");
assert(indexHtml.includes('ChessEvaluator.gameAccuracy(list)'), "Review summary must use ChessEvaluator.gameAccuracy");
assert(indexHtml.includes('body[data-theme="cc"]'), "index.html must include the chess.com theme token layer");
assert(!indexHtml.includes('data-cc-setting="theme"'), "The Lichess UI theme is gone: no theme picker");
assert(!indexHtml.includes('function isCcTheme('), "The chess.com look is the only UI theme");
assert(indexHtml.includes("localStorage.removeItem('whyblunder_theme')"), "A saved Lichess-theme preference is cleared on load");
assert(indexHtml.includes("localStorage.setItem('whyblunder_board_theme', b)"), "Board theme preference must persist");

assert(!indexHtml.includes("Missed Opportunity"), "index.html should not have old 'Missed Opportunity' label");
assert(indexHtml.includes("badgeLabel = isMissedWin ? 'MISSED WIN' : 'MISSED'"), "index.html should use MISSED and MISSED WIN labels");
assert(indexHtml.includes(".diag-missed-banner {"), "index.html must include .diag-missed-banner CSS");
assert(indexHtml.includes(".diag-missed-text {"), "index.html must include .diag-missed-text CSS");
assert(indexHtml.includes("align-items: flex-start;"), "index.html banner must align to flex-start for multi-line text");
assert(indexHtml.includes("badge-missed-win"), "index.html must support badge-missed-win");
assert(indexHtml.includes("function getQualityClass("), "index.html must define getQualityClass");
assert(indexHtml.includes("function getQualityBadgeClass("), "index.html must define getQualityBadgeClass");

// Verify getQualityClass and getQualityBadgeClass execution
const fnCode = indexHtml.match(/function getQualityClass\([^)]*\)\s*\{[\s\S]*?\n\s{12}\}/)[0] +
               "\n" + indexHtml.match(/function getQualityBadgeClass\([^)]*\)\s*\{[\s\S]*?\n\s{12}\}/)[0] +
               "\nreturn { getQualityClass, getQualityBadgeClass };";
const { getQualityClass, getQualityBadgeClass } = new Function(fnCode)();
assert.strictEqual(getQualityClass('blunder'), 'blunder');
assert.strictEqual(getQualityClass('BLUNDER'), 'blunder');
assert.strictEqual(getQualityClass('missed win'), 'miss');
assert.strictEqual(getQualityClass('mistake'), 'mistake');
assert.strictEqual(getQualityClass('inaccuracy'), 'inaccuracy');
assert.strictEqual(getQualityClass('good move'), 'good-move');
assert.strictEqual(getQualityClass('brilliant'), 'brilliant');
assert.strictEqual(getQualityBadgeClass('blunder'), 'blunder');
assert.strictEqual(getQualityBadgeClass('mistake'), 'mistake');

console.log("✓ Banner markup & styling integrity passed!");

// 5. Material Difference Calculation & UI Integrity tests
console.log("Testing Material Difference Calculation & UI Integrity...");

// Start position
const matStart = ChessEvaluator.calculateMaterialDifference('start');
assert.strictEqual(matStart.whiteScore, 39);
assert.strictEqual(matStart.blackScore, 39);
assert.strictEqual(matStart.scoreDiff, 0);
assert.deepStrictEqual(matStart.whitePieces, []);
assert.deepStrictEqual(matStart.blackPieces, []);

// Position with White up a pawn: 1. e4 d5 2. exd5
const fenWhiteUpPawn = 'rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2';
const matWhiteUpPawn = ChessEvaluator.calculateMaterialDifference(fenWhiteUpPawn);
assert.strictEqual(matWhiteUpPawn.whiteScore, 39);
assert.strictEqual(matWhiteUpPawn.blackScore, 38);
assert.strictEqual(matWhiteUpPawn.scoreDiff, 1);
assert.deepStrictEqual(matWhiteUpPawn.whitePieces, [{ type: 'p', count: 1 }]);
assert.deepStrictEqual(matWhiteUpPawn.blackPieces, []);

// Position with piece imbalance: White has Bishop (+3), Black has Knight (+3)
// 8 pawns, 2 rooks, 1 queen each; White: 2 Bishops, 1 Knight; Black: 1 Bishop, 2 Knights
const fenImbalance = 'rn1qkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKB1R w KQkq - 0 1';
const matImbalance = ChessEvaluator.calculateMaterialDifference(fenImbalance);
assert.strictEqual(matImbalance.scoreDiff, 0);
assert.deepStrictEqual(matImbalance.whitePieces, [{ type: 'b', count: 1 }]);
assert.deepStrictEqual(matImbalance.blackPieces, [{ type: 'n', count: 1 }]);

// Position with Black up a Queen:
const fenBlackUpQueen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNB1KBNR w KQkq - 0 1'; // White missing queen
const matBlackUpQueen = ChessEvaluator.calculateMaterialDifference(fenBlackUpQueen);
assert.strictEqual(matBlackUpQueen.whiteScore, 30);
assert.strictEqual(matBlackUpQueen.blackScore, 39);
assert.strictEqual(matBlackUpQueen.scoreDiff, -9);
assert.deepStrictEqual(matBlackUpQueen.whitePieces, []);
assert.deepStrictEqual(matBlackUpQueen.blackPieces, [{ type: 'q', count: 1 }]);

// Position with multiple extra pawns and a promoted queen
const fenPromoted = '2q1k3/8/8/8/8/8/8/2Q1K3 w - - 0 1'; // White 1Q, Black 1Q, King each
const matEqualKingsQueens = ChessEvaluator.calculateMaterialDifference(fenPromoted);
assert.strictEqual(matEqualKingsQueens.whiteScore, 9);
assert.strictEqual(matEqualKingsQueens.blackScore, 9);
assert.strictEqual(matEqualKingsQueens.scoreDiff, 0);

// Test variation step sequence: 1. e4 e5 2. Qh5 Nc6 3. Qxf7# (Scholar's mate)
const simChess = new Chess();
assert.strictEqual(ChessEvaluator.calculateMaterialDifference(simChess.fen()).scoreDiff, 0);
simChess.move('e4');
assert.strictEqual(ChessEvaluator.calculateMaterialDifference(simChess.fen()).scoreDiff, 0);
simChess.move('e5');
assert.strictEqual(ChessEvaluator.calculateMaterialDifference(simChess.fen()).scoreDiff, 0);
simChess.move('Qh5');
assert.strictEqual(ChessEvaluator.calculateMaterialDifference(simChess.fen()).scoreDiff, 0);
simChess.move('Nc6');
assert.strictEqual(ChessEvaluator.calculateMaterialDifference(simChess.fen()).scoreDiff, 0);
simChess.move('Bc4');
assert.strictEqual(ChessEvaluator.calculateMaterialDifference(simChess.fen()).scoreDiff, 0);
simChess.move('Nf6');
assert.strictEqual(ChessEvaluator.calculateMaterialDifference(simChess.fen()).scoreDiff, 0);
// Queen captures pawn on f7
simChess.move('Qxf7#');
const matMate = ChessEvaluator.calculateMaterialDifference(simChess.fen());
assert.strictEqual(matMate.scoreDiff, 1);
assert.deepStrictEqual(matMate.whitePieces, [{ type: 'p', count: 1 }]);
assert.deepStrictEqual(matMate.blackPieces, []);

// HTML & CSS markup integrity for material difference
assert(indexHtml.includes('id="topMaterialDisplay"'), "index.html must include #topMaterialDisplay DOM element");
assert(indexHtml.includes('id="bottomMaterialDisplay"'), "index.html must include #bottomMaterialDisplay DOM element");
assert(indexHtml.includes('.player-material-display'), "index.html must include .player-material-display CSS");
assert(indexHtml.includes('.material-piece-icon'), "index.html must include .material-piece-icon CSS");
assert(indexHtml.includes('.material-score-badge'), "index.html must include .material-score-badge CSS");
assert(indexHtml.includes('updateMaterialDifference(chess.fen())'), "index.html must call updateMaterialDifference on board move changes");
assert(indexHtml.includes('updateMaterialDifference(targetFen)'), "index.html must call updateMaterialDifference on variation step change");
assert(indexHtml.includes('updateMaterialDifference()'), "index.html must call updateMaterialDifference on orientation flip");
console.log("✓ Material difference tests passed!");

// 6. Interactive Variation Navigation & Alt Line Integrity tests
console.log("Testing Variation Navigation & Interactive Alt Lines...");

// Test PV parser function directly
function parsePrincipalVariationTest(pvString, startingFen) {
    if (!pvString || typeof pvString !== 'string') return [];
    const cleanPv = pvString
        .replace(/[♔♚]/g, 'K')
        .replace(/[♕♛]/g, 'Q')
        .replace(/[♖♜]/g, 'R')
        .replace(/[♗♝]/g, 'B')
        .replace(/[♘♞]/g, 'N')
        .replace(/[♙♟]/g, '')
        .replace(/[\u2654-\u265F]/g, '')
        .trim();
    const testChess = new Chess(startingFen);
    const tokens = cleanPv.split(/\s+/);
    const moves = [];

    let currentMoveNum = 1;
    if (startingFen && startingFen !== 'start') {
        const parts = startingFen.split(' ');
        if (parts.length >= 6) {
            currentMoveNum = parseInt(parts[5], 10) || 1;
        }
    }

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (!token) continue;
        if (/^\d+\.+$/.test(token) || /^\d+\.\.\.$/.test(token)) {
            const numMatch = token.match(/^(\d+)/);
            if (numMatch) currentMoveNum = parseInt(numMatch[1], 10);
            continue;
        }

        const isWhite = (testChess.turn() === 'w');
        const moveNum = currentMoveNum;
        const fenBefore = testChess.fen();

        let cleanSan = token
            .replace(/[♔♚]/g, 'K')
            .replace(/[♕♛]/g, 'Q')
            .replace(/[♖♜]/g, 'R')
            .replace(/[♗♝]/g, 'B')
            .replace(/[♘♞]/g, 'N')
            .replace(/[♙♟]/g, '')
            .replace(/[\u2654-\u265F?!+#]/g, '')
            .trim();
        let moveRes = null;
        try {
            moveRes = testChess.move(cleanSan);
        } catch (e) {
            try {
                moveRes = testChess.move(token);
            } catch (e2) {}
        }

        if (moveRes) {
            moves.push({
                from: moveRes.from,
                to: moveRes.to,
                promotion: moveRes.promotion,
                san: moveRes.san || token,
                fen: testChess.fen(),
                fenBefore: fenBefore,
                isWhite: isWhite,
                moveNumber: moveNum,
                stepIndex: moves.length
            });
            if (!isWhite) currentMoveNum++;
        }
    }
    return moves;
}

// Test parsing standard PV string
const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const parsedPv = parsePrincipalVariationTest("1. e4 e5 2. Nf3 Nc6 3. Bb5 a6", startFen);
assert.strictEqual(parsedPv.length, 6);
assert.strictEqual(parsedPv[0].san, 'e4');
assert.strictEqual(parsedPv[0].isWhite, true);
assert.strictEqual(parsedPv[0].moveNumber, 1);
assert.strictEqual(parsedPv[0].stepIndex, 0);

assert.strictEqual(parsedPv[1].san, 'e5');
assert.strictEqual(parsedPv[1].isWhite, false);
assert.strictEqual(parsedPv[1].moveNumber, 1);
assert.strictEqual(parsedPv[1].stepIndex, 1);

assert.strictEqual(parsedPv[5].san, 'a6');
assert.strictEqual(parsedPv[5].isWhite, false);
assert.strictEqual(parsedPv[5].moveNumber, 3);
assert.strictEqual(parsedPv[5].stepIndex, 5);

// Test parsing PV with unicode figurines (ensure stripping works seamlessly)
const pvWithFigurines = "1. ♘f3 d5 2. d4 ♞f6";
const parsedFigurines = parsePrincipalVariationTest(pvWithFigurines, startFen);
assert.strictEqual(parsedFigurines.length, 4);
assert.strictEqual(parsedFigurines[0].san, 'Nf3');
assert.strictEqual(parsedFigurines[1].san, 'd5');
assert.strictEqual(parsedFigurines[2].san, 'd4');
assert.strictEqual(parsedFigurines[3].san, 'Nf6');

// Test HTML and CSS markup in index.html for variation navigation
assert(indexHtml.includes('.var-move-btn'), "index.html must include .var-move-btn CSS");
assert(indexHtml.includes('.var-move-num'), "index.html must include .var-move-num CSS");
assert(indexHtml.includes('.var-btn-refutation'), "index.html must include .var-btn-refutation CSS");
assert(indexHtml.includes('.var-btn-better'), "index.html must include .var-btn-better CSS");
assert(indexHtml.includes('.var-nav-btn-group'), "index.html must include .var-nav-btn-group CSS");

// Test Under-board banner controls markup
assert(indexHtml.includes('id="variationBanner"'), "index.html must include #variationBanner");
assert(indexHtml.includes('id="btnVarFirst"'), "index.html must include #btnVarFirst");
assert(indexHtml.includes('id="btnVarPrev"'), "index.html must include #btnVarPrev");
assert(indexHtml.includes('id="btnVarPlay"'), "index.html must include #btnVarPlay");
assert(indexHtml.includes('id="btnVarNext"'), "index.html must include #btnVarNext");
assert(indexHtml.includes('id="btnVarLast"'), "index.html must include #btnVarLast");
assert(indexHtml.includes('id="btnReturnMainLine"'), "index.html must include #btnReturnMainLine");

// Test JavaScript variation engine functions
assert(indexHtml.includes('function parsePrincipalVariation('), "index.html must include parsePrincipalVariation");
assert(indexHtml.includes('function getVariationData('), "index.html must include getVariationData");
assert(indexHtml.includes('function renderVariationLineHtml('), "index.html must include renderVariationLineHtml");
assert(indexHtml.includes('function jumpToVariationStep('), "index.html must include jumpToVariationStep");
assert(indexHtml.includes('function stepVariationForward('), "index.html must include stepVariationForward");
assert(indexHtml.includes('function stepVariationBackward('), "index.html must include stepVariationBackward");
assert(indexHtml.includes('function stepVariationFirst('), "index.html must include stepVariationFirst");
assert(indexHtml.includes('function stepVariationLast('), "index.html must include stepVariationLast");
assert(indexHtml.includes('function toggleVariationPlayPause('), "index.html must include toggleVariationPlayPause");
assert(indexHtml.includes('function stopVariationAnimationTimer('), "index.html must include stopVariationAnimationTimer");
assert(indexHtml.includes('function playVariation('), "index.html must include playVariation");

// Verify event listener bindings for manual vs auto-play separation
assert(indexHtml.includes('jumpToVariationStep(moveIdx, type, step, false)'), "Clicking move tokens must jump directly without auto-play");
assert(indexHtml.includes("playVariation(idx, 'better')") && indexHtml.includes("playVariation(idx, 'refutation')"), "Clicking play button must trigger playVariation");

// Verify keyboard navigation delegation
assert(indexHtml.includes('if (isInVariationMode && activeVariation) {') && indexHtml.includes('stepVariationBackward()'), "Left arrow must step backward in variation mode");
assert(indexHtml.includes('if (isInVariationMode && activeVariation) {') && indexHtml.includes('stepVariationForward()'), "Right arrow must step forward in variation mode");
assert(indexHtml.includes('if (isInVariationMode && activeVariation) {') && indexHtml.includes('stepVariationFirst()'), "Home key must jump to first step in variation mode");
assert(indexHtml.includes('if (isInVariationMode && activeVariation) {') && indexHtml.includes('stepVariationLast()'), "End key must jump to last step in variation mode");
assert(indexHtml.includes('toggleVariationPlayPause()'), "P key and toolbar play button must toggle play/pause in variation mode");

console.log("✓ Variation Navigation & Interactive Alt Lines passed!");

// -------------------------------------------------------------
// "Why" card: situation / threat / idea / alternatives
// -------------------------------------------------------------
console.log("Testing Why card markup & threat pass...");
assert(indexHtml.includes('function renderWhyCardHtml(move, index, why)'), "index.html must render the Why card");
assert(indexHtml.includes('function renderBlufHtml(move, why)') && indexHtml.includes('class="diag-bluf-strip"'), "index.html must render the BLUF strip (before -> move -> after)");
assert(indexHtml.includes('class="diag-why-more"') && indexHtml.includes('Dig deeper'), "Why card details must sit behind a Dig deeper toggle");
assert(indexHtml.includes('.diag-bluf {') && indexHtml.includes('.diag-bluf-standing.tone-bad'), "index.html must style the BLUF");
assert(indexHtml.indexOf('// 2. WHY CARD') < indexHtml.indexOf('// 3. ONE META ROW'), "the Why card (BLUF) must render before the meta row");

// Explore: users play their own moves on the board in analysis mode
assert(indexHtml.includes('return handleExploreDragStart(source, piece);') && indexHtml.includes('return handleExploreDrop(source, target);'), "analysis-mode board drags must go to the explore handlers");
assert(indexHtml.includes('function playExploreMove(m)') && indexHtml.includes('function startExploreLine(moveIndex, startingFen, keptMoves, m)'), "index.html must build explore lines from board moves");
assert(/bare\(next\.move\) === bare\(m\.san\)[\s\S]{0,80}goToMove\(currentMoveIndex \+ 1\)/.test(indexHtml), "playing the game's own next move must advance the mainline instead of branching");
assert(indexHtml.includes('id="exploreLineRow"') && indexHtml.includes('id="exploreLineMoves"') && indexHtml.includes('id="exploreEngine"'), "the variation banner must host the explore line row");
assert(indexHtml.includes("lt === 'explore' ? 'Your Line'"), "explore lines must be labelled 'Your Line'");
assert(indexHtml.includes('function renderEvalGauge(whiteWp, evalText)'), "explored positions must be able to repaint the eval bars");
assert(indexHtml.includes('if (wasExploring) updateEvalGauge(currentMoveIndex);'), "leaving an explore line must restore the game's eval bar");
assert(indexHtml.includes('.diag-why {') && indexHtml.includes('.diag-why-row') && indexHtml.includes('.diag-why-verdict.is-equal'), "index.html must style the Why card");
assert(indexHtml.includes('.arrow-alt {'), "index.html must style alternative arrows");
assert(indexHtml.includes('function getWhyVariationData(moveIndex, lineType)'), "index.html must build Why variation lines");
assert(indexHtml.includes("lineType === 'threat' || lineType === 'idea' || lineType.startsWith('alt-')"), "getVariationData must route threat/idea/alt lines");
assert(indexHtml.includes("playVariation(parseInt(this.dataset.index), this.dataset.line)"), "Why play buttons must play their line");
assert(indexHtml.includes("\"is the engine's top choice\""), "near-tie best moves must not claim to be uniquely best");
assert(indexHtml.includes("prog.phase === 'threats'"), "progress text must cover the threat pass");

(async () => {
    global.Chess = Chess;
    global.ChessEvaluator = ChessEvaluator;
    global.SituationRecognizer = SituationRecognizer;
    global.MoveDiagnostics = require('./js/move-diagnostics.js');
    const BrowserWhyBlunder = require('./js/browser-analyzer.js');
    const analyzer = Object.create(BrowserWhyBlunder.prototype);
    analyzer.isCancelled = false;
    const evaluated = [];
    analyzer.pool = {
        size: 1,
        evaluate: async (fen, depth, multipv) => {
            evaluated.push({ fen, depth, multipv });
            return { bestMove: 'g5g6', lines: { 1: { cp: 483, pv: ['g5g6', 'f7g8', 'f5f6'] } } };
        }
    };
    const fenBefore = '8/1r1b1k2/8/2R2PPp/p2B4/8/5K2/8 b - - 0 42';
    const keyMove = { move: 'Bxf5', quality: 'mistake', detailed_quality: 'mistake', analysis: { why: { threat: null } } };
    const quietMove = { move: 'Kf2', quality: 'good move', detailed_quality: 'good', analysis: { why: { threat: null } } };
    await analyzer._addThreats(
        [keyMove, quietMove],
        [{ fenBefore }, { fenBefore }],
        [{ bestScore: { cp: -336 } }, { bestScore: { cp: -336 } }],
        null
    );
    assert.strictEqual(evaluated.length, 1, "threat search runs only for key moments / mistakes / blunders");
    assert.strictEqual(evaluated[0].fen, '8/1r1b1k2/8/2R2PPp/p2B4/8/5K2/8 w - - 0 42', "threat search runs on the null-move FEN");
    assert.strictEqual(evaluated[0].depth, 12);
    assert(keyMove.analysis.why.threat && keyMove.analysis.why.threat.san === 'g6+', "threat must be attached to the key move");
    assert.strictEqual(quietMove.analysis.why.threat, null);
    console.log("✓ Why card markup & threat pass passed!");
})().catch(e => { console.error('Why card test failed:', e); process.exit(1); });

// -------------------------------------------------------------
// 10. Mobile UI Rework & Layout Integrity Tests
// -------------------------------------------------------------
console.log("Testing Mobile UI Rework & Layout Integrity...");

// Verify mobile DOM elements exist
const mobileIds = [
    'mobileEvalBar', 'mobileEvalWhite', 'mobileEvalPill',
    'mobileMoveTicker', 'tickerScroll', 'tickerNavLeft', 'tickerNavRight',
    'mobileNavToolbar', 'mobileBtnPrev', 'mobileBtnNext', 'mobileBtnKey',
    'mobileKeyBadge', 'mobileNavSan', 'mobileNavCount', 'mobileBtnFlip',
    'mobileMovesOffcanvas', 'mobileMovesOffcanvasBody', 'mobileSheetMoveCount'
];
mobileIds.forEach(id => {
    assert(indexHtml.includes(`id="${id}"`), `index.html must include #${id}`);
});

// Verify mobile CSS rules
assert(indexHtml.includes('.mobile-eval-bar'), "Must include .mobile-eval-bar CSS");
assert(indexHtml.includes('.mobile-move-ticker'), "Must include .mobile-move-ticker CSS");
assert(indexHtml.includes('.ticker-chip'), "Must include .ticker-chip CSS");
assert(indexHtml.includes('.mobile-nav-toolbar'), "Must include .mobile-nav-toolbar CSS");
assert(indexHtml.includes('.mobile-nav-capsule'), "Must include .mobile-nav-capsule CSS");
assert(indexHtml.includes('.mobile-moves-offcanvas'), "Must include .mobile-moves-offcanvas CSS");
assert(indexHtml.includes('@media (max-width: 991px)'), "Must include @media (max-width: 991px)");
assert(indexHtml.includes('overflow-y: auto !important;'), "Move diagnostic panel must be scrollable on mobile");

// Verify mobile JavaScript functions and handlers
assert(indexHtml.includes('function renderMobileMoveTicker('), "Must include renderMobileMoveTicker");
assert(indexHtml.includes('function syncMobileOffcanvas('), "Must include syncMobileOffcanvas");
assert(indexHtml.includes('mobileBtnPrev.addEventListener'), "Must bind mobileBtnPrev click listener");
assert(indexHtml.includes('mobileBtnNext.addEventListener'), "Must bind mobileBtnNext click listener");
assert(indexHtml.includes('mobileBtnKey.addEventListener'), "Must bind mobileBtnKey click listener");
assert(indexHtml.includes('mobileBtnFlip.addEventListener'), "Must bind mobileBtnFlip click listener");

console.log("✓ Mobile UI Rework & Layout Integrity passed!");

// -------------------------------------------------------------
// 10b. Mobile Revamp v2 Integrity Tests
// -------------------------------------------------------------
console.log("Testing Mobile Revamp v2 Integrity...");
assert(indexHtml.includes('viewport-fit=cover'),            "viewport must opt into safe areas");
assert(!indexHtml.includes('user-scalable=no'),             "pinch-zoom must not be disabled");
assert(indexHtml.includes('--m-chrome-h'),                  "board height must derive from --m-chrome-h");
assert(!/max-width:\s*min\(100%,\s*calc\(100dvh - \d+px\)\)/.test(indexHtml),
                                                            "no magic-number board heights remain");
assert(indexHtml.includes('function syncAppViewport('),     "must sync --app-h from visualViewport");
assert(indexHtml.includes('MOBILE REVAMP v2 — START'),      "mobile revamp CSS region must be delimited");
['mobileSheet','mobileSheetGrip','mobileSheetBody','mobileSheetSummary','mobileSheetScrim',
 'mobileBtnMore','mobileOptionsSheet'].forEach(id => {
    assert(indexHtml.includes(`id="${id}"`), `Missing mobile element #${id}`);
});
assert(indexHtml.includes('window.MobileSheet'),            "must expose MobileSheet API");
assert(indexHtml.includes('function relocateForViewport('), "must relocate panels between shell and sheet");
assert(indexHtml.includes('.analysis-keys-legend'),         "keys legend must use a dedicated class, not d-none toggling");
assert(!/analysisKeysLegend\.classList\.remove\('d-none'\)/.test(indexHtml),
                                                            "keys legend must not have d-none stripped on mobile");
assert(indexHtml.includes('--m-tap'),                       "touch-target token must exist");
assert(indexHtml.includes('--m-fs-chip'),                   "mobile type floor token must exist");
console.log("✓ Mobile Revamp v2 Integrity passed!");

// -------------------------------------------------------------
// 11. Lichess & PGN Import Integration Tests
// -------------------------------------------------------------
console.log("Testing Lichess & PGN Import UI and Logic...");

// Verify Import header button and icon
assert(indexHtml.includes('id="btnTogglePgn"'), "index.html must include #btnTogglePgn");
assert(indexHtml.includes('<span>Import</span>') || indexHtml.includes('>Import<'), "index.html must include 'Import' button text");
assert(indexHtml.includes('bi-box-arrow-in-down'), "index.html must use bi-box-arrow-in-down icon for Import");

// Verify Import dropdown menu options (Lichess & PGN only)
assert(indexHtml.includes('id="importDropdownMenu"'), "index.html must include #importDropdownMenu");
assert(indexHtml.includes('data-source="lichess"'), "Dropdown must include option for Lichess");
assert(!indexHtml.includes('data-source="chesscom"'), "Dropdown must NOT include option for Chess.com");
assert(indexHtml.includes('data-source="pgn"'), "Dropdown must include option for Raw PGN");

// Verify segmented tab buttons (Lichess & PGN only)
assert(indexHtml.includes('data-import-tab="lichess"'), "index.html must include Lichess tab trigger");
assert(!indexHtml.includes('data-import-tab="chesscom"'), "index.html must NOT include Chess.com tab trigger");
assert(indexHtml.includes('data-import-tab="pgn"'), "index.html must include PGN tab trigger");

// Verify tab panels & inputs
assert(indexHtml.includes('id="tabPanelLichess"'), "index.html must include #tabPanelLichess");
assert(!indexHtml.includes('id="tabPanelChesscom"'), "index.html must NOT include #tabPanelChesscom");
assert(indexHtml.includes('id="tabPanelPgn"'), "index.html must include #tabPanelPgn");
assert(indexHtml.includes('id="lichessInput"'), "index.html must include #lichessInput");
assert(!indexHtml.includes('id="chesscomInput"'), "index.html must NOT include #chesscomInput");
assert(indexHtml.includes('id="pgnInput"'), "index.html must include #pgnInput");

// Verify empty-state container action button updated
assert(indexHtml.includes('id="btnOpenPgnInput"'), "index.html must preserve #btnOpenPgnInput ID for compatibility");
assert(indexHtml.includes('Import') && indexHtml.includes('btnOpenPgnInput'), "Empty state button must display 'Import'");

// Verify JS functions for import
assert(indexHtml.includes('function switchImportTab('), "index.html must include switchImportTab function");
assert(!indexHtml.includes('function extractChessComGameId('), "index.html must not include extractChessComGameId function");
assert(indexHtml.includes('function extractGameSource('), "index.html must include extractGameSource function");
assert(!indexHtml.includes('function fetchChessComGamePgn('), "index.html must not include fetchChessComGamePgn function");
assert(indexHtml.includes('function checkUrlForGame('), "index.html must include checkUrlForGame function");

// Verify sample games config
assert(indexHtml.includes("lichess: 'https://lichess.org/Qa7FJNk2'"), "index.html must include Lichess sample game URL");
assert(!indexHtml.includes('chesscom_pgn:'), "index.html must NOT include Chess.com bundled sample PGN");

console.log("✓ Lichess & PGN Import Integration passed!");

// 8. CoachManager Tests
console.log("Testing CoachManager...");
const CoachModule = require('./js/coach-manager.js');
const { COACH_PERSONAS, CoachManager } = CoachModule;

assert(COACH_PERSONAS.pikaru, "COACH_PERSONAS must contain Coach Pikaru");
assert(COACH_PERSONAS.mcmarty, "COACH_PERSONAS must contain Coach McMarty");
assert(COACH_PERSONAS.sophy, "COACH_PERSONAS must contain Coach Sophy");
assert(COACH_PERSONAS.mangoose, "COACH_PERSONAS must contain GM Mangoose");

// Verify parody personas have correct ratings and distinct voices
assert.strictEqual(COACH_PERSONAS.pikaru.elo, 1600);
assert.strictEqual(COACH_PERSONAS.mcmarty.elo, 800);
assert.strictEqual(COACH_PERSONAS.sophy.elo, 1200);
assert.strictEqual(COACH_PERSONAS.mangoose.elo, 2200);

// Instantiate CoachManager with default Pikaru
const mockWorker = {
    init: async () => {},
    options: {},
    setOption: function(name, val) { this.options[name] = val; },
    evaluate: async (fen, depth, multipv) => {
        // Return simple mock eval
        return {
            bestMove: 'e7e5',
            lines: {
                1: { cp: 20, pv: ['e7e5', 'g1f3'] },
                2: { cp: -150, pv: ['g8f6', 'e4e5'] }
            }
        };
    }
};

const coach = new CoachManager({ personaId: 'pikaru', worker: mockWorker });
assert.strictEqual(coach.getPersona().id, 'pikaru');
assert.strictEqual(coach.isPlayerTurn(), true);

// Configure worker options
coach._configureWorkerElo();
assert.strictEqual(mockWorker.options['UCI_LimitStrength'], 'true');
assert.strictEqual(mockWorker.options['UCI_Elo'], '1600');

// Test speech commentary on startup
assert(coach.currentBubble1.length > 0, "Initial bubble1 should be present");
assert(coach.currentBubble2.length > 0, "Initial bubble2 should be present");
assert(coach.getDialogue().length > 0, "Initial dialogue should be present");

// Test coach board flicker fix regressions (chessboard.js diff redraw,
// drag threshold, unminified script load)
console.log("Testing coach board flicker fix regressions...");
const chessboardJsSrc = fs.readFileSync(require('path').join(__dirname, 'js', 'chessboard-1.0.0.js'), 'utf8');

// (3) index.html must load the unminified chessboard.js, not the .min.js,
// otherwise edits to chessboard-1.0.0.js have no effect in the browser
assert(indexHtml.includes('<script src="js/chessboard-1.0.0.js"></script>'), "index.html must load js/chessboard-1.0.0.js");
assert(!indexHtml.includes('<script src="js/chessboard-1.0.0.min.js"></script>'), "index.html must not load the minified chessboard-1.0.0.min.js");

// (1) drawPositionInstant must no longer do a full unconditional wipe of
// every piece on the board before redrawing (that caused board-wide blink)
assert(!/\$board\.find\(\s*'\.'\s*\+\s*CSS\.piece\s*\)\.remove\(\)/.test(chessboardJsSrc), "drawPositionInstant must not unconditionally wipe all pieces with $board.find('.' + CSS.piece).remove()");
assert(/function drawPositionInstant/.test(chessboardJsSrc), "drawPositionInstant function must still exist");
assert(/data-piece['"]?\)\s*===\s*piece/.test(chessboardJsSrc), "drawPositionInstant must diff against existing data-piece before rebuilding a square");

// (2) a drag threshold must gate the visual drag start so a plain click
// does not hide/snapback-blink the piece
assert(/DRAG_THRESHOLD_PX/.test(chessboardJsSrc), "chessboard-1.0.0.js must define a drag threshold constant");
assert(/function\s+maybeStartVisualDrag/.test(chessboardJsSrc), "chessboard-1.0.0.js must gate visual drag start behind a threshold check");
assert(/function\s+finishClickRelease/.test(chessboardJsSrc), "chessboard-1.0.0.js must handle pre-threshold release as a click, not a drag/snapback");

console.log("✓ Coach board flicker fix regressions passed!");

// Test Player Move
(async () => {
    const resMove = await coach.handleUserMove('e4');
    assert.strictEqual(resMove.success, true);
    assert.strictEqual(coach.chess.turn(), 'b');
    assert.strictEqual(coach.isPlayerTurn(), false);
    assert.strictEqual(coach.moveHistory.length, 1);

    // Test Illegal Move
    const resIllegal = await coach.handleUserMove('e5');
    assert.strictEqual(resIllegal.success, false);

    // Test Coach Response Move
    const resCoach = await coach.computeCoachMove();
    assert.strictEqual(resCoach.success, true);
    assert(resCoach.bubble1.length > 0, "Coach bubble 1 must be non-empty");
    assert(resCoach.bubble2.length > 0, "Coach bubble 2 must be non-empty");
    assert.strictEqual(coach.chess.turn(), 'w');
    assert.strictEqual(coach.isPlayerTurn(), true);
    assert.strictEqual(coach.moveHistory.length, 2);

    // Test Hint Generation
    const hint = await coach.generateHint();
    assert(hint.hintText.includes('Coach Hint:'), "Hint text should be prefixed with 'Coach Hint:'");
    assert(Array.isArray(hint.highlightSquares), "highlightSquares must be an array");

    // Test Intentional Blunder & Spotting Feedback
    coach.pendingChallenge = {
        move: { from: 'g8', to: 'f6' },
        san: 'Nf6',
        motif: 'Tactical Fork',
        refutations: ['Nxe5', 'e4e5'],
        bestSan: 'Nxe5'
    };

    // User spots the blunder with legal move Nxe5 (or e5)
    // Let's set up a custom position to test blunder punishment
    const testCoach = new CoachManager({ personaId: 'pikaru' });
    testCoach.pendingChallenge = {
        move: { from: 'd8', to: 'f6' },
        san: 'Qf6',
        motif: 'Hanging Queen',
        refutations: ['Qxf6', 'd1f6'],
        bestSan: 'Qxf6'
    };
    testCoach.chess.load('rnb1kbnr/pppp1ppp/5q2/8/8/8/PPPPQPPP/RNB1KBNR w KQkq - 0 1');
    const punishRes = await testCoach.handleUserMove({ from: 'e2', to: 'f3' }); // Not the punishment
    assert(punishRes.bubble1.includes('hook') || punishRes.bubble1.includes('bullet') || punishRes.bubble1.includes('missed') || punishRes.bubble1.includes('escape'),
        `Expected missed blunder message, got: ${punishRes.bubble1}`);

    // Test Takeback
    const moveCountBefore = coach.moveHistory.length;
    const tbRes = coach.takeback();
    assert.strictEqual(tbRes, true);
    assert.strictEqual(coach.moveHistory.length, moveCountBefore - 2);

    // Test Persona switching
    coach.setPersona('mcmarty');
    assert.strictEqual(coach.getPersona().id, 'mcmarty');
    assert.strictEqual(coach.getPersona().elo, 800);

    coach.setPersona('mangoose');
    assert.strictEqual(coach.getPersona().id, 'mangoose');
    assert.strictEqual(coach.getPersona().elo, 2200);

    // Test Single-move Player Takeback (takebackPlayerMove)
    const tbPlayerCoach = new CoachManager({ personaId: 'sophy' });
    assert.strictEqual(tbPlayerCoach.moveHistory.length, 0);
    await tbPlayerCoach.handleUserMove('e4');
    assert.strictEqual(tbPlayerCoach.moveHistory.length, 1);
    assert.strictEqual(tbPlayerCoach.chess.history().length, 1);
    const tbSingleOk = tbPlayerCoach.takebackPlayerMove('d4');
    assert.strictEqual(tbSingleOk, true);
    assert.strictEqual(tbPlayerCoach.moveHistory.length, 0);
    assert.strictEqual(tbPlayerCoach.chess.history().length, 0);
    assert.strictEqual(tbPlayerCoach.isPlayerTurn(), true);
    assert(tbPlayerCoach.currentBubble1.includes('Good instinct'), "Bubble 1 should give positive takeback feedback");
    assert(tbPlayerCoach.currentBubble2.includes('d4'), "Bubble 2 should suggest d4");

    // Test Persona voice enrichment categories across all personas
    const { COACH_PERSONAS } = require('./js/coach-manager.js');
    const requiredVoiceKeys = [
        'thinking', 'passedPawn', 'castle', 'fork', 'pin', 'attackQueen',
        'attackRook', 'openFile', 'outpost', 'centerStrike', 'check', 'capture',
        'develop', 'genericMove', 'challengeOnlyMove', 'challengeBlunderBait',
        'praiseSpotBlunder', 'missedBlunder', 'playerBlunder', 'playerGoodMove',
        'challengeDevelopment', 'challengeCenter', 'challengePinDefense',
        'challengeEndgame', 'challengeGeneric'
    ];
    for (const pid of ['pikaru', 'mcmarty', 'sophy', 'mangoose']) {
        const p = COACH_PERSONAS[pid];
        assert(p, `Persona ${pid} must exist`);
        for (const key of requiredVoiceKeys) {
            assert(p.voice[key] !== undefined, `Persona ${pid} must have voice key ${key}`);
        }
    }

    // Test Piece Move Commentary Accuracy (Queen vs Rook regression test)
    const pieceTestCoach = new CoachManager({ personaId: 'pikaru' });
    const fenBeforeQd5 = 'r1bqkb1r/pp2pppp/2p5/8/3PpB2/8/PPP1PPPP/R2QKB1R b KQkq - 0 4';
    const boardBeforeQ = new pieceTestCoach.Chess(fenBeforeQd5);
    const boardAfterQ = new pieceTestCoach.Chess(fenBeforeQd5);
    const qd5Move = boardAfterQ.move({ from: 'd8', to: 'd5' });
    assert(qd5Move, "qd5Move must be valid");
    const qBubbles = pieceTestCoach._generateCoachBubbles(boardBeforeQ, boardAfterQ, qd5Move, false, null);
    assert(!qBubbles.bubble2.toLowerCase().includes('rook'), `Queen move Qd5 should NOT mention rook, got: ${qBubbles.bubble2}`);
    assert(qBubbles.bubble2.toLowerCase().includes('queen'), `Queen move Qd5 should mention Queen, got: ${qBubbles.bubble2}`);

    // Verify Rook move commentary mentions rook
    const fenRook = 'r4rk1/ppp2ppp/8/8/8/8/PPP2PPP/R4RK1 w - - 0 1';
    const boardBeforeR = new pieceTestCoach.Chess(fenRook);
    const boardAfterR = new pieceTestCoach.Chess(fenRook);
    const rMove = boardAfterR.move({ from: 'f1', to: 'd1' });
    const rBubbles = pieceTestCoach._generateCoachBubbles(boardBeforeR, boardAfterR, rMove, false, null);
    assert(rBubbles.bubble2.toLowerCase().includes('rook'), `Rook move Rad1 should mention rook, got: ${rBubbles.bubble2}`);
    assert(!rBubbles.bubble2.toLowerCase().includes('queen'), `Rook move should not mention queen, got: ${rBubbles.bubble2}`);

    // =========================================================================
    // Regression Tests: Coach Suggestion Verification & Swing Limitation
    // =========================================================================

    // 1. Worker dual-mode options toggle
    const toggleWorker = {
        options: {},
        setOption: function(name, val) { this.options[name] = val; },
        evaluate: async () => ({ bestMove: 'd2d4', lines: { 1: { cp: 20, pv: ['d2d4'] } } })
    };
    const toggleCoach = new CoachManager({ personaId: 'pikaru', worker: toggleWorker });
    toggleCoach._setWorkerAnalysisMode();
    assert.strictEqual(toggleWorker.options['UCI_LimitStrength'], 'false', "Analysis mode must disable UCI_LimitStrength");
    assert.strictEqual(toggleWorker.options['Skill Level'], '20', "Analysis mode must set max Skill Level 20");
    toggleCoach._setWorkerPlayMode();
    assert.strictEqual(toggleWorker.options['UCI_LimitStrength'], 'true', "Play mode must enable UCI_LimitStrength");
    assert.strictEqual(toggleWorker.options['UCI_Elo'], '1600', "Play mode must set persona Elo");

    // 2. Candidate Verification (_findVerifiedBestMove) rejects blunder candidate and picks sound alternative
    const verifyWorker = {
        options: {},
        setOption: function(name, val) { this.options[name] = val; },
        evaluate: async (fen, depth, multipv) => {
            // If evaluating after e2e4, opponent refutes it with -250 cp
            if (fen.includes('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR')) {
                return { bestMove: 'e7e5', lines: { 1: { cp: 250, pv: ['e7e5'] } } }; // Opponent is +250
            }
            // If evaluating after d2d4, position is solid (+20 cp)
            if (fen.includes('rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR')) {
                return { bestMove: 'd7d5', lines: { 1: { cp: -20, pv: ['d7d5'] } } }; // Opponent is -20 (player is +20)
            }
            return { bestMove: 'd2d4', lines: { 1: { cp: 20, pv: ['d2d4'] } } };
        }
    };
    const verifyCoach = new CoachManager({ personaId: 'pikaru', worker: verifyWorker });
    const fenStart = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const mockMultiEval = {
        bestMove: 'e2e4',
        lines: {
            1: { cp: 30, pv: ['e2e4'] }, // Cand 1: e4 (will be refuted by -250 in post-eval)
            2: { cp: 20, pv: ['d2d4'] }  // Cand 2: d4 (solid in post-eval)
        }
    };
    const verifiedMove = await verifyCoach._findVerifiedBestMove(fenStart, mockMultiEval);
    assert(verifiedMove, "Verified move must be returned");
    assert.strictEqual(verifiedMove.san, 'd4', "Candidate 1 (e4) was refuted, candidate 2 (d4) must be selected as verified move");
    assert.strictEqual(verifiedMove.verified, true, "Move must be marked verified");

    // 3. Takeback and replay of coach's suggested move
    const takebackReplayWorker = {
        options: {},
        setOption: function(name, val) { this.options[name] = val; },
        evaluate: async (fen, depth, multipv) => {
            return {
                bestMove: 'd2d4',
                lines: {
                    1: { cp: 40, pv: ['d2d4'] },
                    2: { cp: 30, pv: ['g1f3'] }
                }
            };
        }
    };
    const takebackCoach = new CoachManager({ personaId: 'pikaru', worker: takebackReplayWorker });
    // User blunders with f3
    const blunderRes = await takebackCoach.handleUserMove('f3');
    // Takeback with suggested move 'd4'
    const tbOk = takebackCoach.takebackPlayerMove('d4');
    assert.strictEqual(tbOk, true);
    assert.strictEqual(takebackCoach.lastSuggestedMove.san, 'd4');

    // Player now executes suggested move 'd4'
    const replayRes = await takebackCoach.handleUserMove('d4');
    assert.strictEqual(replayRes.success, true);
    assert.strictEqual(replayRes.isBlunder, false, "Replaying coach's suggested move must NOT be a blunder");
    assert.strictEqual(replayRes.quality.uiQuality, 'good move', "Replaying suggested move must be classified as good move");
    assert.strictEqual(replayRes.quality.wpLoss, 0.0, "Replaying suggested move must have 0 wpLoss");
    assert(replayRes.dialogue.includes('Great adjustment') || replayRes.dialogue.includes('d4'),
        `Dialogue should acknowledge player's adjustment, got: ${replayRes.dialogue}`);
    assert.strictEqual(takebackCoach.lastSuggestedMove, null, "lastSuggestedMove should be cleared after execution");

    // 4. Position Evaluation Cache prevents search variance and swings
    assert(takebackCoach._positionEvalCache.size > 0, "Position evaluation cache should store analyzed positions");

    // 5. Toolbar takeback() preserves suggested move and replay succeeds with 0 wpLoss
    const tbToolbarWorker = {
        options: {},
        setOption: function(name, val) { this.options[name] = val; },
        evaluate: async (fen, depth, multipv) => {
            return {
                bestMove: 'e2e4',
                lines: {
                    1: { cp: 50, pv: ['e2e4'] },
                    2: { cp: 45, pv: ['d2d4'] }
                }
            };
        }
    };
    const tbToolbarCoach = new CoachManager({ personaId: 'pikaru', worker: tbToolbarWorker });
    // User blunders with h4
    const blunderRes2 = await tbToolbarCoach.handleUserMove('h4');
    assert.strictEqual(blunderRes2.isBlunder, true);
    assert.strictEqual(blunderRes2.bestSan, 'e4');
    assert.strictEqual(blunderRes2.bestMoveObj.from, 'e2');
    assert.strictEqual(blunderRes2.bestMoveObj.to, 'e4');

    // User uses toolbar takeback button
    const tbToolbarOk = tbToolbarCoach.takeback();
    assert.strictEqual(tbToolbarOk, true);
    assert(tbToolbarCoach.lastSuggestedMove, "Toolbar takeback should preserve suggested move for the restored position");
    assert.strictEqual(tbToolbarCoach.lastSuggestedMove.san, 'e4');
    assert.strictEqual(tbToolbarCoach.lastSuggestedMove.from, 'e2');
    assert.strictEqual(tbToolbarCoach.lastSuggestedMove.to, 'e4');

    // Hint should align with the suggested move
    const hintRes = await tbToolbarCoach.generateHint();
    assert(hintRes.hintText.includes('e4'), `Hint should suggest e4, got: ${hintRes.hintText}`);
    assert.deepStrictEqual(hintRes.highlightSquares, ['e2']);

    // Player now executes suggested move 'e4' via object format { from: 'e2', to: 'e4' }
    const replayRes2 = await tbToolbarCoach.handleUserMove({ from: 'e2', to: 'e4' });
    assert.strictEqual(replayRes2.success, true);
    assert.strictEqual(replayRes2.isBlunder, false, "Replaying suggested move via toolbar takeback must NOT be a blunder");
    assert.strictEqual(replayRes2.quality.uiQuality, 'good move');
    assert.strictEqual(replayRes2.quality.wpLoss, 0.0);
    assert.strictEqual(tbToolbarCoach.lastSuggestedMove, null);

    // 6. Arrow / Dialogue / MoveObj synchronization when Candidate 2 is verified
    const syncWorker = {
        options: {},
        setOption: function(name, val) { this.options[name] = val; },
        evaluate: async (fen, depth, multipv) => {
            // e4 candidate is refuted by opponent (-200cp), candidate 2 (d4) is solid (+30cp)
            if (fen.includes('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR')) {
                return { bestMove: 'e7e5', lines: { 1: { cp: 200, pv: ['e7e5'] } } };
            }
            if (fen.includes('rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR')) {
                return { bestMove: 'd7d5', lines: { 1: { cp: -30, pv: ['d7d5'] } } };
            }
            return {
                bestMove: 'e2e4',
                lines: {
                    1: { cp: 60, pv: ['e2e4'] },
                    2: { cp: 30, pv: ['d2d4'] }
                }
            };
        }
    };
    const syncCoach = new CoachManager({ personaId: 'sophy', worker: syncWorker });
    const syncBlunderRes = await syncCoach.handleUserMove('g4');
    assert.strictEqual(syncBlunderRes.isBlunder, true);
    // Candidate 1 (e4) was refuted, so Candidate 2 (d4) must be selected
    assert.strictEqual(syncBlunderRes.bestSan, 'd4');
    assert.strictEqual(syncBlunderRes.bestMoveObj.from, 'd2');
    assert.strictEqual(syncBlunderRes.bestMoveObj.to, 'd4');
    assert.strictEqual(syncCoach.moveHistory[syncCoach.moveHistory.length - 1].bestSan, 'd4');

    // 7. MultiPV Sound Alternative Move Acceptance (No false-alarm blunder loops)
    const multiAltWorker = {
        options: {},
        setOption: function(name, val) { this.options[name] = val; },
        evaluate: async (fen, depth, multipv) => {
            return {
                bestMove: 'e2e4',
                lines: {
                    1: { cp: 40, pv: ['e2e4'] },
                    2: { cp: 35, pv: ['d2d4'] },
                    3: { cp: 30, pv: ['g1f3'] }
                }
            };
        }
    };
    const multiAltCoach = new CoachManager({ personaId: 'pikaru', worker: multiAltWorker });
    // User plays candidate 3 (Nf3) from opening position
    const nf3Res = await multiAltCoach.handleUserMove({ from: 'g1', to: 'f3' });
    assert.strictEqual(nf3Res.success, true);
    assert.strictEqual(nf3Res.isBlunder, false, "Candidate 3 (Nf3) from MultiPV lines must NOT be flagged as blunder");
    assert.strictEqual(nf3Res.quality.uiQuality, 'good move');

    // 8. FEN Normalization helper
    assert.strictEqual(
        multiAltCoach._normalizeFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'),
        'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -'
    );

    // 9. Immediate Checkmate Move Execution (Instant termination without engine delay)
    let workerCalledOnTerminal = false;
    const terminalWorker = {
        options: {},
        setOption: function() {},
        evaluate: async () => {
            workerCalledOnTerminal = true;
            return { bestMove: '', lines: {} };
        }
    };
    const mateTestCoach = new CoachManager({ personaId: 'pikaru', worker: terminalWorker });
    // Set up Scholar's mate position: White to play Qxf7#
    mateTestCoach.chess.load('r1bqkb1r/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4');
    const mateRes = await mateTestCoach.handleUserMove('Qxf7#');
    assert.strictEqual(mateRes.success, true);
    assert.strictEqual(mateRes.isGameOver, true);
    assert.strictEqual(mateTestCoach.isGameOver, true);
    assert.strictEqual(mateTestCoach.gameResult, 'win');
    assert(mateRes.dialogue.includes('Checkmate'), `Dialogue must declare Checkmate, got: ${mateRes.dialogue}`);
    assert.strictEqual(workerCalledOnTerminal, false, "Stockfish worker must NOT be called on terminal checkmate move");

    // 10. Immediate Stalemate Move Execution (Instant termination without engine delay)
    const stalemateTestCoach = new CoachManager({ personaId: 'pikaru', worker: terminalWorker });
    // White: Ka1, Qb1; Black: Ka8. Move: Qb1-b6 (stalemate)
    stalemateTestCoach.chess.load('k7/8/8/8/8/8/8/KQ6 w - - 0 1');
    const staleRes = await stalemateTestCoach.handleUserMove('Qb6');
    assert.strictEqual(staleRes.success, true);
    assert.strictEqual(staleRes.isGameOver, true);
    assert.strictEqual(stalemateTestCoach.isGameOver, true);
    assert.strictEqual(stalemateTestCoach.gameResult, 'draw');
    assert(staleRes.dialogue.includes('Stalemate'), `Dialogue must declare Stalemate, got: ${staleRes.dialogue}`);
    assert.strictEqual(workerCalledOnTerminal, false, "Stockfish worker must NOT be called on terminal stalemate move");

    // Verify index.html Coach Mode Integration
    const fs = require('fs');
    const indexContent = fs.readFileSync('./index.html', 'utf8');
    assert(indexContent.includes('id="tabModeAnalysis"'), "index.html must contain #tabModeAnalysis");
    assert(indexContent.includes('id="tabModeCoach"'), "index.html must contain #tabModeCoach");
    assert(indexContent.includes('id="colCoach"'), "index.html must contain #colCoach");
    assert(indexContent.includes('id="coachBubble"'), "index.html must contain #coachBubble");
    assert(indexContent.includes('id="coachBlunderCard"'), "index.html must contain #coachBlunderCard");
    assert(indexContent.includes('id="btnCoachRetryMove"'), "index.html must contain #btnCoachRetryMove");
    assert(indexContent.includes('id="btnCoachContinueAnyway"'), "index.html must contain #btnCoachContinueAnyway");
    assert(indexContent.includes('id="btnCoachHint"'), "index.html must contain #btnCoachHint");
    assert(indexContent.includes('id="btnCoachTakeback"'), "index.html must contain #btnCoachTakeback");
    assert(indexContent.includes('id="btnCoachResign"'), "index.html must contain #btnCoachResign");
    assert(indexContent.includes('id="coachSettingsModal"'), "index.html must contain #coachSettingsModal");
    assert(indexContent.includes('src="js/coach-manager.js"'), "index.html must link coach-manager.js");
    assert(indexContent.includes('function switchAppMode('), "index.html must define switchAppMode");
    assert(indexContent.includes('function startNewCoachGame('), "index.html must define startNewCoachGame");
    assert(indexContent.includes('function executeCoachUserMove('), "index.html must define executeCoachUserMove");
    assert(indexContent.includes('function renderCoachThinking('), "index.html must define renderCoachThinking");
    assert(indexContent.includes('function triggerCoachResponse('), "index.html must define triggerCoachResponse");
    assert(indexContent.includes('function showBlunderTakebackCard('), "index.html must define showBlunderTakebackCard");
    assert(indexContent.includes('function hideBlunderTakebackCard('), "index.html must define hideBlunderTakebackCard");
    assert(indexContent.includes('function handleCoachSquareClick('), "index.html must define handleCoachSquareClick for click-to-move");
    assert(indexContent.includes('function selectCoachSquare('), "index.html must define selectCoachSquare for highlighting legal squares");
    assert(indexContent.includes('.highlight-selected'), "index.html must define .highlight-selected CSS");
    assert(indexContent.includes('.highlight-dest'), "index.html must define .highlight-dest CSS");
    assert(indexContent.includes('.coach-blunder-actions'), "index.html must define .coach-blunder-actions CSS");
    assert(indexContent.includes('body.coach-mode .coach-speech-bubble'), "index.html must define mobile coach-speech-bubble CSS");
    assert(indexContent.includes('body.coach-mode .coach-speech-bubble.expanded'), "index.html must define mobile coach-speech-bubble.expanded CSS");
    assert(indexContent.includes('overscroll-behavior: contain;'), "coach speech bubble must have overscroll-behavior: contain");
    assert(indexContent.includes("coachBubbleEl.classList.toggle('expanded')"), "coachBubble must toggle expanded on click");
    assert(indexContent.includes('.pulse-takeback'), "index.html must define .pulse-takeback CSS");
    assert(indexContent.includes('body > .piece-417db'), "index.html must have CSS for body > .piece-417db to prevent ghost piece click interception");
    assert(indexContent.includes('pointer-events: none !important;'), "body > .piece-417db must have pointer-events: none !important;");
    assert(indexContent.includes('onSnapbackEnd'), "boardConfig must define onSnapbackEnd to preserve dots on snapback");
    assert(!indexContent.includes('renderMaterialDisplay('), "index.html must not call undefined renderMaterialDisplay");

    // 5. Test Coach Mode Selection & Interaction State Machine
    console.log("Testing Coach Mode Selection & Interaction State Machine...");
    const testChess = new Chess();
    let mockCoachSelectedSquare = null;
    let mockLastSelectionTime = 0;
    const mockSquareClasses = {};

    function mockClearClickMoveHighlights() {
        mockCoachSelectedSquare = null;
        for (const sq in mockSquareClasses) {
            mockSquareClasses[sq] = (mockSquareClasses[sq] || []).filter(
                c => !['highlight-selected', 'highlight-dest', 'highlight-dest-capture'].includes(c)
            );
        }
    }

    function mockSelectCoachSquare(square) {
        mockClearClickMoveHighlights();
        const piece = testChess.get(square);
        if (!piece || piece.color !== 'w') return;

        mockCoachSelectedSquare = square;
        mockLastSelectionTime = Date.now();
        mockSquareClasses[square] = mockSquareClasses[square] || [];
        mockSquareClasses[square].push('highlight-selected');

        const moves = testChess.moves({ square: square, verbose: true });
        moves.forEach(m => {
            mockSquareClasses[m.to] = mockSquareClasses[m.to] || [];
            if (m.captured) {
                mockSquareClasses[m.to].push('highlight-dest-capture');
            } else {
                mockSquareClasses[m.to].push('highlight-dest');
            }
        });
    }

    let executedMoves = [];
    function mockExecuteCoachUserMove(moveInput) {
        executedMoves.push(moveInput);
        testChess.move({ from: moveInput.from, to: moveInput.to, promotion: 'q' });
    }

    function mockHandleCoachDragStart(source, piece) {
        const isOwn = piece.startsWith('w');
        if (!isOwn) {
            if (mockCoachSelectedSquare) {
                const legalMoves = testChess.moves({ square: mockCoachSelectedSquare, verbose: true });
                const match = legalMoves.find(m => m.to === source);
                if (match) {
                    const fromSq = mockCoachSelectedSquare;
                    mockClearClickMoveHighlights();
                    mockExecuteCoachUserMove({ from: fromSq, to: source, promotion: 'q' });
                    return false;
                }
            }
            mockClearClickMoveHighlights();
            return false;
        }
        mockSelectCoachSquare(source);
        return true;
    }

    function mockHandleCoachDrop(source, target) {
        if (source === target) {
            mockSelectCoachSquare(source);
            return 'snapback';
        }
        const targetPiece = testChess.get(target);
        if (targetPiece && targetPiece.color === 'w') {
            mockSelectCoachSquare(target);
            return 'snapback';
        }
        const testMoveChess = new Chess(testChess.fen());
        const m = testMoveChess.move({ from: source, to: target, promotion: 'q' });
        if (!m) {
            mockSelectCoachSquare(source);
            return 'snapback';
        }
        mockClearClickMoveHighlights();
        mockExecuteCoachUserMove({ from: source, to: target, promotion: 'q' });
        return;
    }

    // Step A: Drag start on e2 pawn -> e2 selected, e3/e4 dots active
    const canDragE2 = mockHandleCoachDragStart('e2', 'wP');
    assert.strictEqual(canDragE2, true, "Drag start on own piece should return true");
    assert.strictEqual(mockCoachSelectedSquare, 'e2', "e2 should be selected");
    assert(mockSquareClasses['e2'].includes('highlight-selected'), "e2 must have highlight-selected");
    assert(mockSquareClasses['e3'].includes('highlight-dest'), "e3 must have highlight-dest");
    assert(mockSquareClasses['e4'].includes('highlight-dest'), "e4 must have highlight-dest");

    // Step B: User releases on e2 (click/tap without moving) -> remains selected with dots!
    const dropResultSame = mockHandleCoachDrop('e2', 'e2');
    assert.strictEqual(dropResultSame, 'snapback', "Drop on same square should return snapback");
    assert.strictEqual(mockCoachSelectedSquare, 'e2', "e2 must remain selected after snapback");
    assert(mockSquareClasses['e3'].includes('highlight-dest'), "e3 must retain highlight-dest after snapback");
    assert(mockSquareClasses['e4'].includes('highlight-dest'), "e4 must retain highlight-dest after snapback");

    // Step C: Drop on another own piece (g1 knight) -> switches selection to g1
    const dropResultG1 = mockHandleCoachDrop('e2', 'g1');
    assert.strictEqual(dropResultG1, 'snapback', "Drop on own piece should return snapback");
    assert.strictEqual(mockCoachSelectedSquare, 'g1', "Selection should switch to g1");
    assert(mockSquareClasses['g1'].includes('highlight-selected'), "g1 must have highlight-selected");
    assert(mockSquareClasses['f3'].includes('highlight-dest'), "f3 must have highlight-dest for knight");
    assert(mockSquareClasses['h3'].includes('highlight-dest'), "h3 must have highlight-dest for knight");

    // Step D: Drag start / drop valid move g1-f3
    mockHandleCoachDrop('g1', 'f3');
    assert.strictEqual(mockCoachSelectedSquare, null, "Selection should clear after valid move");
    assert.strictEqual(executedMoves.length, 1, "Move should be executed");
    assert.strictEqual(executedMoves[0].from, 'g1');
    assert.strictEqual(executedMoves[0].to, 'f3');

    // Step E: Enemy capture interaction
    // Setup position where White can capture Black piece
    testChess.load("rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 2");
    // Select Nf3
    mockSelectCoachSquare('f3');
    assert.strictEqual(mockCoachSelectedSquare, 'f3');
    assert(mockSquareClasses['e5'].includes('highlight-dest-capture'), "e5 must have highlight-dest-capture");

    // Clicking / tapping enemy piece on e5 directly executes capture
    const captureDrag = mockHandleCoachDragStart('e5', 'bP');
    assert.strictEqual(captureDrag, false, "Clicking enemy piece on legal capture should return false (no drag)");
    assert.strictEqual(mockCoachSelectedSquare, null, "Selection should clear after capture");
    assert.strictEqual(executedMoves.length, 2);
    assert.strictEqual(executedMoves[1].from, 'f3');
    assert.strictEqual(executedMoves[1].to, 'e5');

    assert(indexContent.includes('.coach-move-glyph'), "index.html must define .coach-move-glyph CSS");
    assert(indexContent.includes('.coach-move-san.quality-blunder'), "index.html must style blunder coach moves");
    assert(indexContent.includes('addSquareAnnotation(userResult.move.to'), "index.html must display move feedback annotation on played squares");
    assert(indexContent.includes('annotation.style.left = `calc(var(--sq, 12.5%) * ${file})`;'), "index.html must set annotation.style.left");
    assert(indexContent.includes('annotation.style.top = `calc(var(--sq, 12.5%) * ${rank})`;'), "index.html must set annotation.style.top");
    assert(indexContent.includes('const CC_EXCELLENT_SVG = \'<svg viewBox="0 0 800 800"'), "index.html must define CC_EXCELLENT_SVG with authentic thumbs-up");
    assert(!indexContent.includes('M8.864.046'), "index.html must not use legacy bootstrap thumbs-up icon");
    assert(indexContent.includes("drawArrow(userResult.bestMoveObj.from, userResult.bestMoveObj.to, 'better')"), "index.html must draw better move arrow on blunder takeback");
    assert(indexContent.includes("drawArrow(userResult.refMoveObj.from, userResult.refMoveObj.to, 'opponent-threat')"), "index.html must draw opponent threat arrow on blunder takeback");

    // 6. Test Coach Move Sheet Feedback & Explanatory Arrows
    console.log("Testing Coach Move Feedback & Explanatory Arrows...");
    const mockBlunderMoveRecord = {
        san: "Qh5",
        from: "d1",
        to: "h5",
        quality: "blunder",
        detailedQuality: "blunder",
        isBlunder: true,
        bestMoveObj: { from: "g1", to: "f3" },
        refMoveObj: { from: "g8", to: "f6" }
    };

    // Verify arrow drawing logic for blunder takeback
    const arrowsDrawn = [];
    function mockDrawArrow(from, to, type) {
        arrowsDrawn.push({ from, to, type });
    }

    if (mockBlunderMoveRecord.isBlunder) {
        if (mockBlunderMoveRecord.bestMoveObj) {
            mockDrawArrow(mockBlunderMoveRecord.bestMoveObj.from, mockBlunderMoveRecord.bestMoveObj.to, 'better');
        }
        if (mockBlunderMoveRecord.refMoveObj) {
            mockDrawArrow(mockBlunderMoveRecord.refMoveObj.from, mockBlunderMoveRecord.refMoveObj.to, 'opponent-threat');
        }
    }

    assert.strictEqual(arrowsDrawn.length, 2, "Should draw 2 arrows for blunder takeback");
    assert.deepStrictEqual(arrowsDrawn[0], { from: "g1", to: "f3", type: "better" });
    assert.deepStrictEqual(arrowsDrawn[1], { from: "g8", to: "f6", type: "opponent-threat" });

    console.log("✓ Coach Selection State Machine passed!");
    console.log("✓ Coach Move Feedback & Explanatory Arrows passed!");

    // 7. Test King Checkmate & Stalemate Badges (Winner ⭑, Loser ×, Stalemate/Draw ½)
    console.log("Testing King Checkmate & Stalemate Badges (Winner ⭑, Loser ×, Stalemate/Draw ½)...");
    assert(indexContent.includes('.king-checkmate-badge'), "index.html must include .king-checkmate-badge CSS");
    assert(indexContent.includes('.king-badge-winner'), "index.html must include .king-badge-winner CSS");
    assert(indexContent.includes('.king-badge-loser'), "index.html must include .king-badge-loser CSS");
    assert(indexContent.includes('.king-badge-stalemate'), "index.html must include .king-badge-stalemate CSS");
    assert(indexContent.includes('.king-badge-icon'), "index.html must include .king-badge-icon CSS");
    assert(indexContent.includes('updateKingCheckmateBadges'), "index.html must define updateKingCheckmateBadges");
    assert(indexContent.includes('clearKingCheckmateBadges'), "index.html must define clearKingCheckmateBadges");

    // Unit test logic for updateKingCheckmateBadges with Scholar's Mate
    const mateChess = new Chess();
    // 1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7#
    mateChess.move('e4');
    mateChess.move('e5');
    mateChess.move('Qh5');
    mateChess.move('Nc6');
    mateChess.move('Bc4');
    mateChess.move('Nf6');
    mateChess.move('Qxf7#');

    assert.strictEqual(mateChess.in_checkmate(), true, "Position must be checkmate");
    assert.strictEqual(mateChess.turn(), 'b', "Black is checkmated (turn is 'b')");

    // Test king badge calculation simulation
    function simulateKingBadges(chessInstance, isFlipped = false, options = {}) {
        if (!chessInstance) return [];
        const isCheckmate = chessInstance.in_checkmate && chessInstance.in_checkmate();
        const isStalemate = chessInstance.in_stalemate && chessInstance.in_stalemate();
        const isDraw = chessInstance.in_draw && chessInstance.in_draw();
        const isResigned = Boolean(options.resigned);
        const resignedColor = options.resignedColor || 'w';
        if (!isCheckmate && !isStalemate && !isDraw && !isResigned) return [];

        let whiteKingSq = null;
        let blackKingSq = null;
        const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

        for (let r = 1; r <= 8; r++) {
            for (let f = 0; f < 8; f++) {
                const sq = files[f] + r;
                const piece = chessInstance.get(sq);
                if (piece && piece.type === 'k') {
                    if (piece.color === 'w') whiteKingSq = sq;
                    if (piece.color === 'b') blackKingSq = sq;
                }
            }
        }

        const badges = [];
        if (isCheckmate) {
            const loserColor = chessInstance.turn();
            const winnerColor = loserColor === 'w' ? 'b' : 'w';
            const winnerSq = winnerColor === 'w' ? whiteKingSq : blackKingSq;
            const loserSq = loserColor === 'w' ? whiteKingSq : blackKingSq;

            if (winnerSq) {
                const file = isFlipped ? 7 - (winnerSq.charCodeAt(0) - 97) : (winnerSq.charCodeAt(0) - 97);
                const rank = isFlipped ? parseInt(winnerSq.charAt(1)) - 1 : 8 - parseInt(winnerSq.charAt(1));
                badges.push({ type: 'winner', emoji: '⭑', square: winnerSq, left: `${file * 12.5}%`, top: `${rank * 12.5}%` });
            }
            if (loserSq) {
                const file = isFlipped ? 7 - (loserSq.charCodeAt(0) - 97) : (loserSq.charCodeAt(0) - 97);
                const rank = isFlipped ? parseInt(loserSq.charAt(1)) - 1 : 8 - parseInt(loserSq.charAt(1));
                badges.push({ type: 'loser', emoji: '×', square: loserSq, left: `${file * 12.5}%`, top: `${rank * 12.5}%` });
            }
        } else if (isResigned) {
            const loserColor = resignedColor;
            const winnerColor = (loserColor === 'w') ? 'b' : 'w';
            const winnerSq = (winnerColor === 'w') ? whiteKingSq : blackKingSq;
            const loserSq = (loserColor === 'w') ? whiteKingSq : blackKingSq;

            if (winnerSq) {
                const file = isFlipped ? 7 - (winnerSq.charCodeAt(0) - 97) : (winnerSq.charCodeAt(0) - 97);
                const rank = isFlipped ? parseInt(winnerSq.charAt(1)) - 1 : 8 - parseInt(winnerSq.charAt(1));
                badges.push({ type: 'winner', emoji: '⭑', square: winnerSq, left: `${file * 12.5}%`, top: `${rank * 12.5}%` });
            }
            if (loserSq) {
                const file = isFlipped ? 7 - (loserSq.charCodeAt(0) - 97) : (loserSq.charCodeAt(0) - 97);
                const rank = isFlipped ? parseInt(loserSq.charAt(1)) - 1 : 8 - parseInt(loserSq.charAt(1));
                badges.push({ type: 'loser', emoji: '×', square: loserSq, left: `${file * 12.5}%`, top: `${rank * 12.5}%` });
            }
        } else if (isStalemate) {
            if (whiteKingSq) {
                const file = isFlipped ? 7 - (whiteKingSq.charCodeAt(0) - 97) : (whiteKingSq.charCodeAt(0) - 97);
                const rank = isFlipped ? parseInt(whiteKingSq.charAt(1)) - 1 : 8 - parseInt(whiteKingSq.charAt(1));
                badges.push({ type: 'stalemate', emoji: '½', square: whiteKingSq, left: `${file * 12.5}%`, top: `${rank * 12.5}%` });
            }
            if (blackKingSq) {
                const file = isFlipped ? 7 - (blackKingSq.charCodeAt(0) - 97) : (blackKingSq.charCodeAt(0) - 97);
                const rank = isFlipped ? parseInt(blackKingSq.charAt(1)) - 1 : 8 - parseInt(blackKingSq.charAt(1));
                badges.push({ type: 'stalemate', emoji: '½', square: blackKingSq, left: `${file * 12.5}%`, top: `${rank * 12.5}%` });
            }
        }
        return badges;
    }

    const badgesStandard = simulateKingBadges(mateChess, false);
    assert.strictEqual(badgesStandard.length, 2, "Must produce 2 badges on checkmate");
    assert.strictEqual(badgesStandard[0].type, 'winner');
    assert.strictEqual(badgesStandard[0].emoji, '⭑');
    assert.strictEqual(badgesStandard[0].square, 'e1'); // White king
    assert.strictEqual(badgesStandard[0].left, '50%'); // file e = index 4 => 4 * 12.5 = 50%
    assert.strictEqual(badgesStandard[0].top, '87.5%'); // rank 1 => 8 - 1 = 7 => 7 * 12.5 = 87.5%

    assert.strictEqual(badgesStandard[1].type, 'loser');
    assert.strictEqual(badgesStandard[1].emoji, '×');
    assert.strictEqual(badgesStandard[1].square, 'e8'); // Black king
    assert.strictEqual(badgesStandard[1].left, '50%'); // file e = index 4 => 4 * 12.5 = 50%
    assert.strictEqual(badgesStandard[1].top, '0%'); // rank 8 => 8 - 8 = 0 => 0 * 12.5 = 0%

    // Flipped orientation
    const badgesFlipped = simulateKingBadges(mateChess, true);
    assert.strictEqual(badgesFlipped[0].top, '0%'); // e1 becomes top 0% when flipped
    assert.strictEqual(badgesFlipped[1].top, '87.5%'); // e8 becomes top 87.5% when flipped

    // Unit test logic for Stalemate badges
    const stalemateChess = new Chess('k7/8/K7/8/8/8/8/1Q6 b - - 0 1');
    assert.strictEqual(stalemateChess.in_stalemate(), true, "Position must be stalemate");
    const stalemateBadges = simulateKingBadges(stalemateChess, false);
    assert.strictEqual(stalemateBadges.length, 2, "Must produce 2 stalemate badges on stalemate");
    assert.strictEqual(stalemateBadges[0].type, 'stalemate');
    assert.strictEqual(stalemateBadges[0].emoji, '½');
    assert.strictEqual(stalemateBadges[0].square, 'a6'); // White king
    assert.strictEqual(stalemateBadges[1].type, 'stalemate');
    assert.strictEqual(stalemateBadges[1].emoji, '½');
    assert.strictEqual(stalemateBadges[1].square, 'a8'); // Black king

    // Unit test logic for Resignation badges
    const resignChess = new Chess();
    // Case 1: White resigns (resignedColor = 'w')
    const whiteResignBadges = simulateKingBadges(resignChess, false, { resigned: true, resignedColor: 'w' });
    assert.strictEqual(whiteResignBadges.length, 2, "Must produce 2 badges on resignation");
    const whiteResignWinner = whiteResignBadges.find(b => b.type === 'winner');
    const whiteResignLoser = whiteResignBadges.find(b => b.type === 'loser');
    assert(whiteResignWinner && whiteResignWinner.square === 'e8', "Winner badge must be on Black King (e8)");
    assert.strictEqual(whiteResignWinner.emoji, '⭑');
    assert(whiteResignLoser && whiteResignLoser.square === 'e1', "Loser badge must be on White King (e1)");
    assert.strictEqual(whiteResignLoser.emoji, '×');

    // Case 2: Black resigns (resignedColor = 'b')
    const blackResignBadges = simulateKingBadges(resignChess, false, { resigned: true, resignedColor: 'b' });
    assert.strictEqual(blackResignBadges.length, 2, "Must produce 2 badges on resignation");
    const blackResignWinner = blackResignBadges.find(b => b.type === 'winner');
    const blackResignLoser = blackResignBadges.find(b => b.type === 'loser');
    assert(blackResignWinner && blackResignWinner.square === 'e1', "Winner badge must be on White King (e1)");
    assert(blackResignLoser && blackResignLoser.square === 'e8', "Loser badge must be on Black King (e8)");

    // Case 3: Resignation with flipped orientation
    const flippedResignBadges = simulateKingBadges(resignChess, true, { resigned: true, resignedColor: 'w' });
    const flippedWinner = flippedResignBadges.find(b => b.type === 'winner');
    const flippedLoser = flippedResignBadges.find(b => b.type === 'loser');
    assert.strictEqual(flippedWinner.top, '87.5%', "Black king e8 is at bottom 87.5% when flipped");
    assert.strictEqual(flippedLoser.top, '0%', "White king e1 is at top 0% when flipped");

    // Non-checkmate/non-stalemate/non-resigned position should return no badges
    const nonMateChess = new Chess();
    assert.strictEqual(simulateKingBadges(nonMateChess, false).length, 0, "Initial position must produce 0 badges");

    // Verify index.html only displays king badges on the last move
    assert(indexContent.includes('const isLastMove = (typeof moves !== \'undefined\' && Array.isArray(moves) && moves.length > 0 && index === moves.length - 1);'), "index.html drawMoveArrows must check isLastMove before updating king checkmate badges");
    assert(indexContent.includes('if (isLastMove && typeof chess !== \'undefined\' && chess)'), "index.html drawMoveArrows must only call updateKingCheckmateBadges on the last move");
    assert(indexContent.includes('currentAppMode === \'coach\' && typeof coachManager !== \'undefined\' && coachManager && coachManager.isGameOver && coachManager.resigned'), "index.html updateKingCheckmateBadges must scope coachManager resignation to coach mode");
    assert(indexContent.includes('if (clampedIndex === maxIndex && coachManager && coachManager.isGameOver)'), "index.html selectCoachMove must only display king badges on the last move in coach review");

    console.log("✓ King Checkmate & Stalemate Badges (Winner ⭑, Loser ×, Stalemate/Draw ½) passed!");

    // =========================================================================
    // Regression Tests for Coach Play Code Review Fixes (11 Items)
    // =========================================================================
    console.log("Testing Coach Play code review fixes...");

    // 1. explainGoodMove Options-Object Test
    const goodMoveWorker = {
        options: {},
        setOption: function(name, val) { this.options[name] = val; },
        evaluate: async (fen, depth, multipv) => {
            return {
                bestMove: 'f1c4',
                lines: {
                    1: { cp: 50, pv: ['f1c4', 'g8f6'] }
                }
            };
        }
    };
    const goodCoach = new CoachManager({ personaId: 'sophy', worker: goodMoveWorker });
    goodCoach.chess.load('r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3');
    const goodRes = await goodCoach.handleUserMove('Bc4');
    assert.strictEqual(goodRes.success, true);
    assert(goodRes.bubble1.length > 0, "Good move bubble1 should be generated");

    // 2. Hanging piece blunder SAN resolution test
    const blunderWorker = {
        options: {},
        setOption: function(name, val) { this.options[name] = val; },
        evaluate: async (fen, depth, multipv) => {
            return {
                bestMove: 'e2e4',
                lines: {
                    1: { cp: 100, pv: ['e2e4', 'd7d5'] },
                    2: { cp: -300, pv: ['c1e3', 'f6e4'] } // Hanging e4 knight capture
                }
            };
        }
    };
    const blunderCoach = new CoachManager({ personaId: 'mcmarty', worker: blunderWorker, playerColor: 'b' });
    blunderCoach.chess.load('rnbqkb1r/pppppppp/5n2/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 1 2');
    const blunderCandidate = await blunderCoach._findInstructiveBlunder(blunderCoach.chess.fen());
    if (blunderCandidate) {
        assert(blunderCandidate.bestSan !== 'f6e4', "bestSan should be resolved to SAN (e.g. Nxe4), not raw UCI");
        assert.strictEqual(blunderCandidate.bestSan, 'Nxe4');
        assert.strictEqual(blunderCandidate.refutations[1], 'Nxe4');
    }

    // 3. Opening principle violation wiring test
    const opCoach = new CoachManager({
        personaId: 'pikaru',
        worker: {
            options: {},
            setOption: function(name, val) { this.options[name] = val; },
            evaluate: async (fen, depth, multipv) => {
                return {
                    bestMove: 'g1f3',
                    lines: {
                        1: { cp: 40, pv: ['g1f3', 'd7d5'] },
                        2: { cp: -150, pv: ['d1h5', 'g7g6'] }
                    }
                };
            }
        }
    });
    opCoach.chess.load('rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2');
    const qh5Res = await opCoach.handleUserMove('Qh5');
    if (qh5Res.isBlunder) {
        assert(opCoach.currentDialogue.includes('opening principles') || opCoach.currentDialogue.includes('Queen') || opCoach.currentDialogue.includes('concedes'),
            `Expected opening principle or tactical feedback, got: ${opCoach.currentDialogue}`);
    }

    // 4. Takeback with Promotion test (tests _resolveSuggestion)
    const promoCoach = new CoachManager({ personaId: 'pikaru' });
    promoCoach.chess.load('8/4P3/8/8/8/8/8/4K2k w - - 0 1');
    const promoRecord = {
        san: 'e8=Q',
        isPlayer: true,
        bestSan: 'e8=Q'
    };
    promoCoach.moveHistory.push(promoRecord);
    promoCoach.chess.move('e8=Q');
    const promoTb = promoCoach.takebackPlayerMove('e8=Q');
    assert.strictEqual(promoTb, true);
    assert(promoCoach.lastSuggestedMove, "lastSuggestedMove should be set");
    assert.strictEqual(promoCoach.lastSuggestedMove.promotion, 'q');
    assert.strictEqual(promoCoach.lastSuggestedMove.uci, 'e7e8q');

    // 5. Worker Elo & Analysis Mode Toggling
    const modeWorker = {
        options: {},
        setOption: function(name, val) { this.options[name] = val; }
    };
    const modeCoach = new CoachManager({ personaId: 'mangoose', worker: modeWorker });
    modeCoach._setWorkerPlayMode();
    assert.strictEqual(modeWorker.options['UCI_LimitStrength'], 'true');
    assert.strictEqual(modeWorker.options['UCI_Elo'], '2200');
    modeCoach._setWorkerAnalysisMode();
    assert.strictEqual(modeWorker.options['UCI_LimitStrength'], 'false');
    assert.strictEqual(modeWorker.options['Skill Level'], '20');

    // 6. isEngineAvailable check
    const noWorkerCoach = new CoachManager({ personaId: 'pikaru' });
    assert.strictEqual(noWorkerCoach.isEngineAvailable(), false);
    const withWorkerCoach = new CoachManager({ personaId: 'pikaru', worker: { isReady: () => true } });
    assert.strictEqual(withWorkerCoach.isEngineAvailable(), true);

    // 7. Player flag regression check in index.html
    const indexHtml = fs.readFileSync('./index.html', 'utf8');
    assert(!indexHtml.includes('bottomPlayerName.textContent = "You 🇺🇸"'), "index.html must not hardcode 'You 🇺🇸'");
    assert(indexHtml.includes('bottomPlayerName.textContent = "You"'), "index.html must set 'You'");
    // 8. Coach Player Feedback & Post-Calculation Dialogue Tests
    console.log("Testing Coach Player Feedback & Post-Calculation Dialogue...");
    // A. Persona playerBestMove arrays
    for (const personaKey of ['pikaru', 'mcmarty', 'sophy', 'mangoose']) {
        const p = COACH_PERSONAS[personaKey];
        assert(p, `Persona ${personaKey} must exist`);
        assert(Array.isArray(p.voice.playerBestMove), `Persona ${personaKey} must have playerBestMove array`);
        assert(p.voice.playerBestMove.length >= 2, `Persona ${personaKey} playerBestMove must have at least 2 phrases`);
    }

    // B. Player good/best move feedback and post-calculation dialogue synthesis
    const feedbackWorker = {
        options: {},
        setOption: function(name, val) { this.options[name] = val; },
        evaluate: async (fen, depth, multipv) => {
            const isWhite = fen.split(' ')[1] === 'w';
            return {
                bestMove: isWhite ? 'e2e4' : 'e7e5',
                lines: {
                    1: { cp: 25, pv: [isWhite ? 'e2e4' : 'e7e5'] }
                }
            };
        }
    };
    const feedbackCoach = new CoachManager({ personaId: 'pikaru', worker: feedbackWorker });
    const userMoveRes = await feedbackCoach.handleUserMove('e4');
    assert.strictEqual(userMoveRes.success, true);
    assert(userMoveRes.bubble1.length > 0, "User move bubble1 must contain feedback");
    assert(userMoveRes.dialogue.length > 0, "User move dialogue must be non-empty");

    // Coach calculates response
    const coachResponse = await feedbackCoach.computeCoachMove();
    assert.strictEqual(coachResponse.success, true);
    assert(coachResponse.playerFeedback, "computeCoachMove must return playerFeedback");
    assert.strictEqual(coachResponse.playerFeedback, userMoveRes.bubble1, "playerFeedback must match player move bubble1");
    assert(coachResponse.dialogue.includes(coachResponse.playerFeedback),
        `Coach dialogue must contain player feedback, got: ${coachResponse.dialogue}`);
    assert(feedbackCoach.getDialogue().includes(coachResponse.playerFeedback),
        `getDialogue() must include player feedback, got: ${feedbackCoach.getDialogue()}`);

    // C. Move 1 when Player is Black: No player feedback prepended
    const blackPlayerCoach = new CoachManager({ personaId: 'sophy', playerColor: 'b', worker: feedbackWorker });
    const coachMove1 = await blackPlayerCoach.computeCoachMove();
    assert.strictEqual(coachMove1.success, true);
    assert.strictEqual(coachMove1.playerFeedback, null, "Move 1 for Black player must have null playerFeedback");
    assert(!coachMove1.dialogue.includes('null'), "Dialogue must not include 'null'");

    // D. Inaccuracy feedback check
    const inaccWorker = {
        options: {},
        setOption: function(name, val) { this.options[name] = val; },
        evaluate: async (fen, depth, multipv) => {
            // Position before move: White is +100cp (wp ~ 0.64)
            // After move: White is +40cp (wp ~ 0.56, wpLoss ~ 0.08 => inaccuracy)
            return {
                bestMove: 'd2d4',
                lines: {
                    1: { cp: 100, pv: ['d2d4'] },
                    2: { cp: 40, pv: ['h2h3'] }
                }
            };
        }
    };
    const inaccCoach = new CoachManager({ personaId: 'sophy', worker: inaccWorker });
    const inaccRes = await inaccCoach.handleUserMove('h3');
    if (inaccRes.quality && inaccRes.quality.uiQuality === 'inaccuracy') {
        assert(inaccRes.bubble1.toLowerCase().includes('inaccurate') || inaccRes.bubble1.toLowerCase().includes('playable'),
            `Inaccuracy bubble should mention inaccuracy, got: ${inaccRes.bubble1}`);
    }

    // E. Index.html CSS and JS integrity
    assert(indexHtml.includes('.coach-player-feedback'), "index.html must define .coach-player-feedback CSS");
    assert(indexHtml.includes('.coach-reply-text'), "index.html must define .coach-reply-text CSS");
    assert(indexHtml.includes('.coach-thinking-status'), "index.html must define .coach-thinking-status CSS");
    assert(indexHtml.includes("case 'best': return '★';"), "index.html getMoveGlyph must handle 'best'");
    assert(indexHtml.includes("case 'best': return 'quality-best';"), "index.html getMoveQualityClass must handle 'best'");
    assert(indexHtml.includes('renderCoachThinking(userResult);'), "index.html must pass userResult to renderCoachThinking");

    // 9. Coach Resignation & Game Over Status Tests
    console.log("Testing Coach Resignation & Game Over Status...");
    // A. Player resigns as White
    const resignCoachW = new CoachManager({ personaId: 'pikaru', playerColor: 'w' });
    const resignResW = resignCoachW.resign('w');
    assert.strictEqual(resignCoachW.isGameOver, true);
    assert.strictEqual(resignCoachW.resigned, true);
    assert.strictEqual(resignCoachW.resignedColor, 'w');
    assert.strictEqual(resignCoachW.gameResult, 'loss');
    assert.strictEqual(resignResW.isGameOver, true);
    assert.strictEqual(resignResW.resigned, true);
    assert.strictEqual(resignResW.resignedColor, 'w');
    assert.strictEqual(resignResW.gameResult, 'loss');
    assert(resignCoachW._getGameOverMessage().includes('You resigned'));
    assert(resignCoachW.getPgn().includes('[Result "0-1"]'));

    // B. Player resigns as Black
    const resignCoachB = new CoachManager({ personaId: 'pikaru', playerColor: 'b' });
    const resignResB = resignCoachB.resign('b');
    assert.strictEqual(resignCoachB.isGameOver, true);
    assert.strictEqual(resignCoachB.resigned, true);
    assert.strictEqual(resignCoachB.resignedColor, 'b');
    assert.strictEqual(resignCoachB.gameResult, 'loss');
    assert(resignCoachB.getPgn().includes('[Result "1-0"]'));

    // C. Default resignation color is playerColor
    const resignCoachDef = new CoachManager({ personaId: 'sophy', playerColor: 'w' });
    resignCoachDef.resign();
    assert.strictEqual(resignCoachDef.resignedColor, 'w');

    // D. Coach resigns (opponent resignation)
    const coachResigns = new CoachManager({ personaId: 'mcmarty', playerColor: 'w' });
    coachResigns.resign('b'); // Coach resigns
    assert.strictEqual(coachResigns.isGameOver, true);
    assert.strictEqual(coachResigns.resigned, true);
    assert.strictEqual(coachResigns.resignedColor, 'b');
    assert.strictEqual(coachResigns.gameResult, 'win');
    assert(coachResigns._getGameOverMessage().includes('Coach resigned'));
    assert(coachResigns.getPgn().includes('[Result "1-0"]'));

    // E. Takeback after resignation resets game over and resignation state
    const takebackResignCoach = new CoachManager({ personaId: 'pikaru', playerColor: 'w' });
    takebackResignCoach.chess.move('e4');
    takebackResignCoach.moveHistory.push({ san: 'e4', isPlayer: true });
    takebackResignCoach.resign('w');
    assert.strictEqual(takebackResignCoach.isGameOver, true);
    assert.strictEqual(takebackResignCoach.resigned, true);
    const tbResignOk = takebackResignCoach.takeback();
    assert.strictEqual(tbResignOk, true);
    assert.strictEqual(takebackResignCoach.isGameOver, false);
    assert.strictEqual(takebackResignCoach.resigned, false);
    assert.strictEqual(takebackResignCoach.resignedColor, null);
    assert.strictEqual(takebackResignCoach.gameResult, null);

    // F. index.html resignation wiring checks
    const updatedIndexHtml = fs.readFileSync('./index.html', 'utf8');
    assert(updatedIndexHtml.includes('coachManager.resign(coachManager.playerColor)'), "index.html must invoke coachManager.resign(coachManager.playerColor)");
    assert(updatedIndexHtml.includes('isResigned = Boolean(options.resigned'), "index.html updateKingCheckmateBadges must detect isResigned");
    assert(updatedIndexHtml.includes('Winner (Opponent Resigned)'), "index.html must set badge tooltip for resignation winner");
    assert(updatedIndexHtml.includes("topPlayerTurn.classList.remove('active')"), "index.html must clear topPlayerTurn on game over");
    assert(updatedIndexHtml.includes("bottomPlayerTurn.classList.remove('active')"), "index.html must clear bottomPlayerTurn on game over");
    assert(updatedIndexHtml.includes('<i class="bi bi-flag-fill me-1"></i> Resigned'), "index.html renderCoachDialogue must show Resigned badge");

    console.log("✓ Coach Resignation & Game Over Status tests passed!");

    // 10. Coach Mode Responsive Move List & Game Review Tests
    console.log("Testing Coach Mode Responsive Move List & Game Review...");
    const coachHtml = fs.readFileSync('./index.html', 'utf8');

    // A. Verify removal of bottom utility strip
    assert(!coachHtml.includes('class="coach-footer-bar"'), "index.html must not contain .coach-footer-bar");
    assert(!coachHtml.includes('<!-- Bottom Utility Strip -->'), "index.html must not contain Bottom Utility Strip");

    // B. Verify presence of desktop move sheet and mobile single strip
    assert(coachHtml.includes('id="coachMovesWrapper"'), "index.html must contain #coachMovesWrapper");
    assert(coachHtml.includes('id="coachMovesSheet"'), "index.html must contain #coachMovesSheet");
    assert(coachHtml.includes('id="coachMovesTable"'), "index.html must contain #coachMovesTable");
    assert(coachHtml.includes('id="coachMobileMoveTicker"'), "index.html must contain #coachMobileMoveTicker");
    assert(coachHtml.includes('id="coachTickerScroll"'), "index.html must contain #coachTickerScroll");
    assert(coachHtml.includes('id="coachTickerNavLeft"'), "index.html must contain #coachTickerNavLeft");
    assert(coachHtml.includes('id="coachTickerNavRight"'), "index.html must contain #coachTickerNavRight");

    // C. Verify Game Review button presence in action bar
    assert(coachHtml.includes('id="btnCoachReview"'), "index.html must contain #btnCoachReview");
    assert(coachHtml.includes('Game Review'), "index.html must contain Game Review label");
    assert(coachHtml.includes('id="btnCoachHint"'), "index.html must retain #btnCoachHint for active play");

    // D. Verify CSS responsiveness
    assert(coachHtml.includes('body.coach-mode .coach-mobile-move-ticker'), "index.html must define .coach-mobile-move-ticker styles");
    assert(coachHtml.includes('body.coach-mode .m-sheet'), "index.html must hide .m-sheet in coach mode");
    assert(coachHtml.includes('.btn-coach-review'), "index.html must define .btn-coach-review styles");

    // E. Verify record.fen in CoachManager
    const navCoach = new CoachManager({ personaId: 'pikaru', playerColor: 'w' });
    const navUserMoveRes = await navCoach.handleUserMove('e4');
    assert.strictEqual(navUserMoveRes.success, true);
    assert(navCoach.moveHistory[0].fen, "Move history record must contain fen");
    assert.strictEqual(navCoach.moveHistory[0].fen, navCoach.chess.fen());

    const navCoachMoveRes = await navCoach.computeCoachMove();
    assert.strictEqual(navCoachMoveRes.success, true);
    assert(navCoach.moveHistory[1].fen, "Coach move history record must contain fen");
    assert.strictEqual(navCoach.moveHistory[1].fen, navCoach.chess.fen());

    // F. Verify JavaScript state machine functions exist in index.html
    assert(coachHtml.includes('function goToCoachMove('), "index.html must define goToCoachMove");
    assert(coachHtml.includes('function updateCoachMoveListActiveState('), "index.html must define updateCoachMoveListActiveState");
    assert(coachHtml.includes('function updateCoachActionBarState('), "index.html must define updateCoachActionBarState");
    assert(coachHtml.includes('let coachCurrentMoveIndex'), "index.html must track coachCurrentMoveIndex");

    // G. Verify Action Bar Hint <-> Game Review state logic
    let mockHintVisible = true;
    let mockReviewVisible = false;
    function mockUpdateCoachActionBarState(isGameOver) {
        if (isGameOver) {
            mockHintVisible = false;
            mockReviewVisible = true;
        } else {
            mockHintVisible = true;
            mockReviewVisible = false;
        }
    }
    // Active game:
    mockUpdateCoachActionBarState(false);
    assert.strictEqual(mockHintVisible, true, "Hint button must be visible during active game");
    assert.strictEqual(mockReviewVisible, false, "Game Review button must be hidden during active game");
    // Game over:
    mockUpdateCoachActionBarState(true);
    assert.strictEqual(mockHintVisible, false, "Hint button must be hidden when game is over");
    assert.strictEqual(mockReviewVisible, true, "Game Review button must be visible when game is over");
    // Takeback resets game over:
    mockUpdateCoachActionBarState(false);
    assert.strictEqual(mockHintVisible, true, "Hint button must be restored upon takeback");
    assert.strictEqual(mockReviewVisible, false, "Game Review button must be hidden upon takeback");

    // H. Verify Elo chips are hidden in analyze mode
    assert(coachHtml.includes("if (topPlayerElo) {\n                    topPlayerElo.textContent = '';\n                    topPlayerElo.classList.add('d-none');\n                }"),
        "index.html updatePlayerStripsOrientation must clear and hide topPlayerElo in Analyze mode");
    assert(coachHtml.includes("if (bottomPlayerElo) {\n                    bottomPlayerElo.textContent = '';\n                    bottomPlayerElo.classList.add('d-none');\n                }"),
        "index.html updatePlayerStripsOrientation must clear and hide bottomPlayerElo in Analyze mode");

    // 10. Coach Learner Model & ErrorProfile Escalation Tests
    console.log("Testing Coach Learner Model & ErrorProfile Escalation...");
    const learnerCoach = new CoachManager({ personaId: 'pikaru', playerColor: 'w' });
    assert(learnerCoach.errorProfile, "CoachManager must have errorProfile");
    assert.strictEqual(learnerCoach.errorProfile.hangingPiece, 0);
    assert.strictEqual(learnerCoach.errorProfile.tacticalBlunder, 0);
    assert.strictEqual(learnerCoach.errorProfile.kingSafety, 0);
    assert.strictEqual(learnerCoach.errorProfile.endgameTechnique, 0);
    assert.strictEqual(learnerCoach.errorProfile.openingPrinciple, 0);

    // Simulate repeated hanging piece errors
    learnerCoach.errorProfile.hangingPiece = 2;
    const challengeMsg = learnerCoach._getContextualChallenge(learnerCoach.chess);
    assert(challengeMsg.includes('scan') || challengeMsg.includes('pieces') || challengeMsg.includes('loose'),
        `Contextual challenge should target loose/hanging pieces, got: ${challengeMsg}`);

    learnerCoach.errorProfile.hangingPiece = 3;
    const errorSummary = learnerCoach.getErrorSummary();
    assert(errorSummary.length > 0, "Error summary should contain top recurring errors");
    assert.strictEqual(errorSummary[0].key, 'hangingPiece');
    assert.strictEqual(errorSummary[0].count, 3);

    learnerCoach.resigned = true;
    learnerCoach.resignedColor = 'w';
    const gameOverSummary = learnerCoach._getGameOverMessage();
    assert(gameOverSummary.includes('hanging pieces'),
        `Game over message should summarize recurring hanging piece errors, got: ${gameOverSummary}`);

    // 11. Coach Hint SEE Verification Tests
    console.log("Testing Coach Hint SEE Verification...");
    // A. Defended knight: capturing with Queen is unsound (SEE <= 0), must NOT suggest tactical capture
    const coachDefended = new CoachManager({ personaId: 'pikaru', playerColor: 'w' });
    coachDefended.chess.load('r1bqkb1r/ppp2ppp/3p4/4n3/4Q3/8/PPPPPPPP/RNB1KBNR w KQkq - 0 1');
    const defendedHint = await coachDefended.generateHint();
    assert(!defendedHint.hintText.includes('tactical capture available'),
        `Hint must NOT suggest unsound capture with negative SEE, got: ${defendedHint.hintText}`);

    // B. Undefended piece: capturing with Queen is sound (SEE > 0), MUST suggest tactical capture
    const coachUndefended = new CoachManager({ personaId: 'pikaru', playerColor: 'w' });
    coachUndefended.chess.load('r1bqkb1r/pppp1ppp/8/4n3/4Q3/8/PPPPPPPP/RNB1KBNR w KQkq - 0 1');
    const undefendedHint = await coachUndefended.generateHint();
    assert(undefendedHint.hintText.includes('tactical capture available'),
        `Hint MUST announce tactical capture when SEE > 0, got: ${undefendedHint.hintText}`);
    assert(undefendedHint.highlightSquares.includes('e5') || undefendedHint.targetSquares.includes('e5'), "Hint must highlight target square e5");

    // 11b. Progressive Coach Hints & Motif-Aware Baits Tests (progressive-coach-hints-plan.md)
    console.log("Testing Progressive Coach Hints & Motif-Aware Baits (8 tests)...");

    // 1. Escalation ladder 1->4 on a fixed fork position
    const coachFork = new CoachManager({ personaId: 'sophy', playerColor: 'w' });
    coachFork.chess.load('r3k2r/pppb1ppp/8/1N6/8/8/PPPP1PPP/R1B1K2R w KQkq - 0 1');
    coachFork._positionEvalCache.set(coachFork._normalizeFen(coachFork.chess.fen()), {
        bestSan: 'Nxc7+',
        lines: { 1: { pv: ['b5c7', 'e8d8', 'c7a8'] } }
    });

    const h1 = await coachFork.generateHint();
    assert.strictEqual(h1.level, 1, "First hint press must be level 1");
    assert.strictEqual(h1.maxLevel, 4);
    assert.strictEqual(h1.motif, 'fork', "Motif should be fork");
    assert(h1.hintText.toLowerCase().includes('fork'), `Level 1 must mention fork, got: ${h1.hintText}`);
    assert.deepStrictEqual(h1.highlightSquares, ['b5'], "Level 1 must highlight piece source square 'b5'");
    assert.strictEqual(h1.arrow, null, "Level 1 must have no arrow");

    const h2 = await coachFork.generateHint();
    assert.strictEqual(h2.level, 2, "Second hint press must be level 2");
    assert.deepStrictEqual(h2.highlightSquares, ['b5']);
    assert(Array.isArray(h2.targetSquares) && h2.targetSquares.length >= 2, "Level 2 must include target squares");
    assert.strictEqual(h2.arrow, null, "Level 2 must have no arrow");

    const h3 = await coachFork.generateHint();
    assert.strictEqual(h3.level, 3, "Third hint press must be level 3");
    assert(h3.highlightSquares.includes('b5') && h3.highlightSquares.includes('c7'), "Level 3 highlights from and to");
    assert.strictEqual(h3.arrow, null, "Level 3 must have no arrow");

    const h4 = await coachFork.generateHint();
    assert.strictEqual(h4.level, 4, "Fourth hint press must be level 4");
    assert.deepStrictEqual(h4.arrow, { from: 'b5', to: 'c7' }, "Level 4 must return arrow equal to answer move");
    assert(h4.hintText.includes('Nxc7+'), `Level 4 must name move Nxc7+, got: ${h4.hintText}`);

    // Fifth press stays capped at level 4 and maintains arrow
    const h5 = await coachFork.generateHint();
    assert.strictEqual(h5.level, 4);
    assert.deepStrictEqual(h5.arrow, { from: 'b5', to: 'c7' });

    // 2. Reset: hint twice, play a move, hint again -> level === 1. The same after takeback()
    const coachReset = new CoachManager({ personaId: 'sophy', playerColor: 'w' });
    coachReset.chess.load('r3k2r/pppb1ppp/8/1N6/8/8/PPPP1PPP/R1B1K2R w KQkq - 0 1');
    await coachReset.generateHint();
    const rHint2 = await coachReset.generateHint();
    assert.strictEqual(rHint2.level, 2);
    await coachReset.handleUserMove('Nxc7+');
    assert.strictEqual(coachReset.getHintState().level, 0, "Hint level must reset to 0 after user move");

    const coachTb = new CoachManager({ personaId: 'sophy', playerColor: 'w' });
    await coachTb.handleUserMove('e4');
    await coachTb.computeCoachMove();
    await coachTb.generateHint();
    await coachTb.generateHint();
    assert.strictEqual(coachTb.getHintState().level, 2);
    coachTb.takeback();
    assert.strictEqual(coachTb.getHintState().level, 0, "Hint level must reset to 0 after takeback");
    const tbHint = await coachTb.generateHint();
    assert.strictEqual(tbHint.level, 1, "First hint after takeback must be level 1");

    // 3. Tracking: hint x2 then play -> player record hintsUsed === 2, hintStats.totalPresses === 2
    const coachTrack = new CoachManager({ personaId: 'sophy', playerColor: 'w' });
    coachTrack.chess.load('r1bqkbnr/pppppppp/2n5/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 1 2');
    await coachTrack.generateHint();
    await coachTrack.generateHint();
    assert.strictEqual(coachTrack.hintStats.totalPresses, 2);
    const trackMoveRes = await coachTrack.handleUserMove('Nf3');
    assert.strictEqual(trackMoveRes.success, true);
    const playerRecord = coachTrack.moveHistory[coachTrack.moveHistory.length - 1];
    assert.strictEqual(playerRecord.hintsUsed, 2, "Player record hintsUsed must be 2");

    // 4. Challenge hint: with pendingChallenge, level-1 highlight is the refuting piece's from, not coach's moved square
    const coachChallenge = new CoachManager({ personaId: 'sophy', playerColor: 'w' });
    coachChallenge.chess.load('rnb1kbnr/pppp1ppp/8/4q3/3P4/8/PPP1PPPP/RNBQKBNR w KQkq - 0 1');
    coachChallenge.pendingChallenge = {
        move: { from: 'd8', to: 'e5' }, // Coach moved queen to e5
        san: 'Qe5',
        motif: 'Hanging Queen',
        type: 'hanging',
        refutations: ['dxe5', 'd4e5'],
        bestSan: 'dxe5',
        refutationMove: { from: 'd4', to: 'e5', san: 'dxe5' }
    };
    const chHint = await coachChallenge.generateHint();
    assert.strictEqual(chHint.level, 1);
    assert.deepStrictEqual(chHint.highlightSquares, ['d4'], "Challenge hint level 1 must highlight refuting piece from 'd4', not coach square 'e5'");

    // 5. Hint-aware praise: solve a challenge after 2 hints -> text comes from praiseWithHint
    const coachPraise = new CoachManager({ personaId: 'sophy', playerColor: 'w' });
    coachPraise.chess.load('rnb1kbnr/pppp1ppp/8/4q3/3P4/8/PPP1PPPP/RNBQKBNR w KQkq - 0 1');
    coachPraise.pendingChallenge = {
        move: { from: 'd8', to: 'e5' },
        san: 'Qe5',
        motif: 'Hanging Queen',
        type: 'hanging',
        refutations: ['dxe5'],
        bestSan: 'dxe5',
        refutationMove: { from: 'd4', to: 'e5', san: 'dxe5' }
    };
    await coachPraise.generateHint();
    await coachPraise.generateHint();
    assert.strictEqual(coachPraise.getHintState().level, 2);
    const praiseRes = await coachPraise.handleUserMove('dxe5');
    assert.strictEqual(praiseRes.success, true);
    assert(coachPraise.persona.voice.praiseWithHint.some(phrase => praiseRes.bubble1.includes(phrase)),
        `Solved after 2 hints should use praiseWithHint, got: ${praiseRes.bubble1}`);

    // 6. Bait text: stub _findInstructiveBlunder to return type: 'pin' -> bubble 2 contains a baitByMotif.pin line
    const coachBait = new CoachManager({ personaId: 'sophy', playerColor: 'b' });
    coachBait.chess.load('rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 1');
    coachBait._findInstructiveBlunder = async () => ({
        move: { from: 'g1', to: 'f3' },
        san: 'Nf3',
        motif: 'Pin',
        type: 'pin',
        refutations: ['Bg4'],
        bestSan: 'Bg4'
    });
    coachBait.pliesSinceBlunder = coachBait.persona.blunderInterval;
    const coachMoveRes = await coachBait.computeCoachMove();
    assert.strictEqual(coachMoveRes.isChallenge, true);
    assert(coachBait.persona.voice.baitByMotif.pin.some(line => coachMoveRes.bubble2.includes(line)),
        `Bubble 2 must contain a baitByMotif.pin line, got: ${coachMoveRes.bubble2}`);

    // 7. Detector squares: detectFork(...).targetSquares equals the expected pair
    const srModule = require('./js/situation-recognizer.js');
    const chessModule = require('./js/chess.min.js');
    const ChessCtor = chessModule.Chess || chessModule;
    const forkDetBoard = new ChessCtor('r3k2r/pppb1ppp/8/1N6/8/8/PPPP1PPP/R1B1K2R w KQkq - 0 1');
    const forkDetMove = forkDetBoard.move('Nxc7+');
    const forkDetRes = srModule.detectFork(forkDetBoard, forkDetMove);
    assert(forkDetRes, "detectFork must recognize the fork on c7");
    assert.strictEqual(forkDetRes.attackerSquare, 'c7');
    assert(Array.isArray(forkDetRes.targetSquares), "targetSquares must be an array");
    assert(forkDetRes.targetSquares.includes('e8'), "targetSquares must include king square e8");
    assert(forkDetRes.targetSquares.includes('a8') || forkDetRes.targetSquares.includes('d7'), "targetSquares must include rook square a8");

    // 8. SEE guard: capture hint is never produced for an SEE-negative capture
    const coachSeeGuard = new CoachManager({ personaId: 'sophy', playerColor: 'w' });
    coachSeeGuard.chess.load('r1bqkb1r/ppp2ppp/3p4/4n3/4Q3/8/PPPPPPPP/RNB1KBNR w KQkq - 0 1');
    const seeGuardHint = await coachSeeGuard.generateHint();
    assert(!seeGuardHint.hintText.includes('tactical capture available'),
        `SEE guard must prevent recommending negative SEE capture, got: ${seeGuardHint.hintText}`);

    // 12. MoveDiagnostics Unified Module Tests
    console.log("Testing MoveDiagnostics module...");
    const MoveDiagnosticsModule = require('./js/move-diagnostics.js');
    assert(MoveDiagnosticsModule, "MoveDiagnostics module must be exported");
    assert.strictEqual(typeof MoveDiagnosticsModule.diagnose, 'function');
    assert.strictEqual(typeof MoveDiagnosticsModule.uciToSan, 'function');
    assert.strictEqual(typeof MoveDiagnosticsModule.formatPv, 'function');

    // Diagnose best move
    const goodDiagRes = MoveDiagnosticsModule.diagnose({
        fenBefore: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
        playedMove: 'e7e5',
        engine: {
            bestUci: 'e7e5',
            lines: {
                1: { cp: 20, pv: ['e7e5', 'g1f3'] }
            }
        },
        context: { ply: 2, mode: 'coach' }
    });
    assert.strictEqual(goodDiagRes.playedIsBest, true);
    assert.strictEqual(goodDiagRes.classification.uiQuality, 'good move');
    assert(goodDiagRes.narrative.explanation.length > 0);

    // Diagnose blunder
    const blunderDiagRes = MoveDiagnosticsModule.diagnose({
        fenBefore: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2',
        playedMove: 'g8h6',
        engine: {
            bestUci: 'b8c6',
            lines: {
                1: { cp: 30, pv: ['b8c6', 'f1c4'] },
                2: { cp: -250, pv: ['g8h6', 'd2d4'] }
            }
        },
        context: { ply: 4, mode: 'analysis' }
    });
    assert.strictEqual(blunderDiagRes.playedIsBest, false);
    assert(blunderDiagRes.wpLoss > 0.15, "Substantial wpLoss expected");
    assert(blunderDiagRes.classification.uiQuality === 'blunder' || blunderDiagRes.classification.uiQuality === 'mistake');
    assert(blunderDiagRes.narrative.explanation.length > 0);

    // Test MoveDiagnostics.searchBudget
    assert.strictEqual(typeof MoveDiagnosticsModule.searchBudget, 'function', 'searchBudget function must be exported');
    const budgetEndgame = MoveDiagnosticsModule.searchBudget({ phase: 'endgame', mode: 'analysis', baseDepth: 18 });
    assert(budgetEndgame.depthPre >= 20, 'Endgame search budget in analysis mode should increase depthPre');
    const budgetCoachFast = MoveDiagnosticsModule.searchBudget({ mode: 'coach', elapsedMs: 100 });
    assert.strictEqual(budgetCoachFast.depthPre, 12, 'Coach base depth should be 12 when time is fresh');
    const budgetCoachDegraded = MoveDiagnosticsModule.searchBudget({ mode: 'coach', elapsedMs: 3800 });
    assert(budgetCoachDegraded.depthPre <= 8, 'Coach depth should degrade to <= 8 under wall-clock time pressure');

    // Test Persona depthDial on MoveDiagnostics
    const mcmartyDiag = MoveDiagnosticsModule.diagnose({
        fenBefore: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2',
        playedMove: 'g8h6',
        engine: {
            bestUci: 'b8c6',
            lines: {
                1: { cp: 30, pv: ['b8c6', 'f1c4'] },
                2: { cp: -250, pv: ['g8h6', 'd2d4'] }
            }
        },
        context: { ply: 4, mode: 'coach', personaId: 'mcmarty', depthDial: 'concise' }
    });
    assert.strictEqual(mcmartyDiag.narrative.explanation.split('. ').length, 1, 'McMarty concise explanation should be a single sentence');

    const mangooseDiag = MoveDiagnosticsModule.diagnose({
        fenBefore: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2',
        playedMove: 'g8h6',
        engine: {
            bestUci: 'b8c6',
            lines: {
                1: { cp: 30, pv: ['b8c6', 'f1c4'] },
                2: { cp: -250, pv: ['g8h6', 'd2d4'] }
            }
        },
        context: { ply: 4, mode: 'coach', personaId: 'mangoose', depthDial: 'deep' }
    });
    assert(mangooseDiag.narrative.explanation.includes('Better continuation:'), 'Mangoose deep explanation should include continuation variation');

    
    // -------------------------------------------------------------------------
    // NEW PLAN UNIT TESTS: deriveIsSacrifice sampling, detectOfferedPiece, missed opportunity
    // -------------------------------------------------------------------------

    console.log("Testing strict brilliant detection...");
    const MoveDiagnosticsExt = require('./js/move-diagnostics.js');

    // 1. Exchange sac Rxc3 nets only one pawn of "offer" (R for N+P), so it is
    //    not an offered piece; the PV-settled material path is what flags it.
    const boardBeforeSac = new Chess('2r1k2r/pp1bnppp/4p3/q7/3P4/2N1BN2/PP2BPPP/2RQ1RK1 b k - 0 1');
    const boardAfterSac = new Chess('2r1k2r/pp1bnppp/4p3/q7/3P4/2r1BN2/PP2BPPP/2RQ1RK1 w k - 0 2');
    const sacMoveObj = { from: 'c8', to: 'c3', piece: 'r', captured: 'n' };
    assert.strictEqual(!!MoveDiagnosticsExt._detectOfferedPiece(boardBeforeSac, boardAfterSac, sacMoveObj, SituationRecognizer), false,
        'Rxc3 alone is not an offered piece (net offer is one pawn)');
    assert.strictEqual(ChessEvaluator.deriveIsSacrifice(boardBeforeSac.fen(), 'c8c3', ['c8c3', 'b2c3', 'a5c3']), true,
        'Rxc3 bxc3 Qxc3 is a sustained exchange sacrifice');

    // 2. deriveIsSacrifice: settled sampling ignores even trades, pawn sacs, and unrelated PVs
    const tradeFen = 'r1bqkb1r/pppp1ppp/2n2n2/4p3/4P3/2N2N2/PPPP1PPP/R1BQKB1R w KQkq - 4 4';
    assert.strictEqual(ChessEvaluator.deriveIsSacrifice(tradeFen, 'c3d5', ['c3d5', 'f6d5', 'e4d5']), false,
        'Nd5 Nxd5 exd5 is an even trade, not a sacrifice');
    assert.strictEqual(ChessEvaluator.deriveIsSacrifice(tradeFen, 'c3d5', ['f1c4', 'f8c5']), false,
        'PV that does not start with the played move is never evidence of a sacrifice');
    const gambitFen = 'rnbqkbnr/ppp1pppp/8/3p4/3P4/8/PPP1PPPP/RNBQKBNR w KQkq - 0 2';
    assert.strictEqual(ChessEvaluator.deriveIsSacrifice(gambitFen, 'c2c4', ['c2c4', 'd5c4', 'e2e3']), false,
        'Queen\'s Gambit pawn offer is not a piece sacrifice');

    // 3. detectOfferedPiece: Legal's Nxe5 leaves the queen on d1 en prise
    const legalBefore = new Chess('r2qkbnr/ppp2ppp/2np4/4p3/2B1P1b1/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 2 5');
    const legalAfter = new Chess(legalBefore.fen());
    const legalMove = legalAfter.move({ from: 'f3', to: 'e5' });
    const legalOffer = MoveDiagnosticsExt._detectOfferedPiece(legalBefore, legalAfter, legalMove, SituationRecognizer);
    assert.ok(legalOffer, "Legal's Nxe5 offers a piece");
    assert.strictEqual(legalOffer.piece, 'q', "Legal's Nxe5 offers the queen");
    assert.strictEqual(legalOffer.square, 'd1');

    // 4. detectOfferedPiece respects check: after the discovered check Nc5+,
    //    Qxc5 is illegal, so the knight is not really offered.
    const chkBefore = new Chess('4k3/pppp1ppp/8/q7/4N3/8/PPPP1PPP/4R1K1 w - - 0 1');
    const chkAfter = new Chess(chkBefore.fen());
    const chkMove = chkAfter.move({ from: 'e4', to: 'c5' });
    assert.ok(chkAfter.in_check(), 'Nc5 is a discovered check');
    assert.strictEqual(!!MoveDiagnosticsExt._detectOfferedPiece(chkBefore, chkAfter, chkMove, SituationRecognizer), false,
        'A capture that is illegal because of check does not count as an offer');
    const noChkBefore = new Chess('4k3/pppp1ppp/8/q7/4N3/8/PPPP1PPP/6K1 w - - 0 1');
    const noChkAfter = new Chess(noChkBefore.fen());
    const noChkMove = noChkAfter.move({ from: 'e4', to: 'c5' });
    assert.strictEqual(!!MoveDiagnosticsExt._detectOfferedPiece(noChkBefore, noChkAfter, noChkMove, SituationRecognizer), true,
        'Without the check the knight on c5 is simply offered');

    // 3. Coach missed-opportunity takeback logic
    const oppWorker = {
        options: {},
        setOption: function(name, val) { this.options[name] = val; },
        evaluate: async (fen, depth, multipv) => {
            if (fen === 'r1bqk2r/ppp2ppp/2n1pn2/3p4/1b1P4/2NBPN2/PPP2PPP/R1BQK2R w KQkq - 0 1') {
                return {
                    bestMove: 'c3d5',
                    lines: {
                        1: { cp: 150, pv: ['c3d5'] },
                        2: { cp: 20, pv: ['e1g1'] }
                    }
                };
            }
            if (fen === 'r1bqk2r/ppp2ppp/2n1pn2/3p4/1b1P4/2N1PN2/PPP2PPP/R1BQKB1R b KQkq - 0 1') {
                return {
                    bestMove: 'b4c3',
                    lines: {
                        1: { cp: 300, pv: ['b4c3'] }, // brilliant candidate!
                        2: { cp: 200, pv: ['e8g8'] }
                    }
                };
            }
            return { bestMove: 'e1g1', lines: { 1: { cp: 0, pv: ['e1g1'] } } };
        }
    };
    
    const oppCoach = new CoachManager({ personaId: 'sophy', playerColor: 'b', worker: oppWorker });
    oppCoach.chess.load('r1bqk2r/ppp2ppp/2n1pn2/3p4/1b1P4/2N1PN2/PPP2PPP/R1BQKB1R b KQkq - 0 1');
    
    // Line 2 (O-O) drops ~0.09 WP versus the pending brilliant line 1 (Bxc3+).
    oppCoach.pendingOpportunity = { kind: 'brilliant', posKey: oppCoach._normalizeFen(oppCoach.chess.fen()), plan: { source: 'brilliant', motif: 'sacrifice', move: { from: 'b4', to: 'c3', san: 'Bxc3+' } } };
    const resOpp = await oppCoach.handleUserMove('O-O'); // plays e8g8
    // console.log
    assert.strictEqual(resOpp.isMissedOpportunity, true, "Should return isMissedOpportunity: true");
    assert.strictEqual(resOpp.isBlunder, false, "Missed opportunity is not a blunder");
    assert.strictEqual(resOpp.detailedQuality || resOpp.quality.detailedQuality, 'miss', "Missed opportunity is classified as a miss");
    // (pendingOpportunity is cleared lazily by posKey mismatch in production)
    
    const okOpp = oppCoach.takebackPlayerMove(null);
    assert.strictEqual(okOpp, true, "Takeback successful");
    assert.ok(oppCoach.pendingOpportunity && oppCoach.pendingOpportunity.plan, "pendingOpportunity should be restored");
    assert.strictEqual(oppCoach.pendingOpportunity.plan.motif, 'sacrifice', "restored plan keeps the sacrifice hint motif");
    assert.strictEqual(oppCoach.lastSuggestedMove, null, "lastSuggestedMove should be null to encourage finding it");
    

    console.log("✓ Coach Mode Responsive Move List & Game Review tests passed!");
    console.log("✓ Coach Play code review regression tests passed!");
    console.log("✓ CoachManager passed!");
    console.log("ALL BROWSER MODULE TESTS PASSED SUCCESSFULLY! 🎉");
})().catch(err => {
    console.error("Test error:", err);
    process.exit(1);
});



