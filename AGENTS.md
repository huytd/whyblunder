# AGENTS.md — Developer & AI Agent Guide for WhyBlunder

> **Welcome, Agent!** This document contains everything you need to know about the WhyBlunder codebase without needing to spend tokens exploring the directory structure, re-discovering invariants, or reverse-engineering design decisions at the start of every session.

---

## 1. Project Overview & Philosophy

**WhyBlunder** is an in-browser, zero-backend chess game analyzer and interactive sparring coach. It runs a parallelized pool of WebAssembly-compiled Stockfish engine workers directly on the client to classify move quality, detect tactical patterns, and generate human-readable explanations.

### Core Architectural Pillars:
1. **Zero-Backend / 100% Client-Side**: All engine calculations, tactical recognition, and storage run entirely inside the user's browser.
2. **Zero Build Step**: No Webpack, Vite, Rollup, Babel, or TypeScript. No `package.json` and no `npm install`. All code is native vanilla ES6+ with UMD wrappers (`js/*.js`) compatible with both browser `<script>` tags and Node.js `require()`.
3. **Single Page Application (SPA)**: `index.html` hosts the entire UI layout, Lichess-inspired dark design system, and main application controller.

---

## 2. Fast Track: Commands & Verification

Because there is no `package.json`, do **not** run `npm test` or `npm run build`. Use standard Node.js:

```bash
# 1. Run full browser module & UI integrity test suite (Node.js)
node test_browser_modules.js

# 2. Run engine-free move diagnostics regression corpus (36+ fixtures)
node test_diagnostics.js

# 3. Start local development server
python3 -m http.server 3030
# Or: npx serve .
# Then open http://localhost:3030 in browser
```

> [!IMPORTANT]
> **Always run both test suites before finishing any task:**
> `node test_browser_modules.js && node test_diagnostics.js`
> Both must pass with 0 failures.

---

## 3. Directory Layout & Key Files

```
whyblunder/
├── index.html                 # ~8k lines: Complete HTML, CSS theme, and main UI logic
├── test_browser_modules.js    # ~2k lines: Node test harness (modules + index.html assertions)
├── test_diagnostics.js        # Engine-free regression corpus (36 fixtures) for diagnostics
├── README.md                  # Public documentation & architecture overview
├── AGENTS.md                  # This file (internal agent onboarding & invariants)
├── docs/
│   └── move-diagnostics-improvement-plan.md  # Active architecture roadmap for diagnostics
├── js/
│   ├── move-diagnostics.js    # Unified MoveDiagnostics.diagnose() pipeline
│   ├── chess-evaluator.js     # Win probability, score mapping, adaptive classification, game phase
│   ├── situation-recognizer.js# 64-sq raycasting, SEE, tactical motifs (fork/pin/skewer/hanging), narratives
│   ├── browser-analyzer.js    # WebAssembly Stockfish worker pool (2-6 workers) & game analysis
│   ├── coach-manager.js       # Interactive sparring coach, 4 personas, hints, learner model
│   ├── analysis-cache.js      # LocalStorage LRU cache (up to 5 games, PGN fingerprinting)
│   ├── opening-detector.js    # Opening book matching & ECO classification
│   ├── stockfish.wasm.js      # Stockfish WASM loader / web worker entry
│   ├── stockfish.wasm         # Stockfish compiled WebAssembly binary
│   ├── stockfish.js           # asm.js fallback engine for environments without WASM
│   ├── chess.min.js           # chess.js v0.10.3 (move generation, legality, FEN)
│   ├── chessboard-1.0.0.js    # chessboard.js board widget
│   └── chessboard-1.0.0.min.js# chessboard.js minified
├── css/
│   ├── chessboard-1.0.0.css   # chessboard.js base styling
│   └── chessboard-1.0.0.min.css
└── img/
    ├── app-icon.svg / favicon.svg
    └── chesspieces/           # SVG/PNG chess piece sets (wikipedia default)
```

---

## 4. Permanent Invariants & Guardrails (Never Break These!)

### 1. Zero Build / No Bundler Invariant
- **NEVER** introduce npm dependencies, package.json scripts, webpack, vite, or typescript compilers.
- Code in `js/` must remain pure vanilla JavaScript (ES6+), directly runnable via `<script>` in the browser and via `require()` in Node.js.

### 2. UMD Module Pattern Invariant
All core modules in `js/` must follow the UMD pattern:
```javascript
(function(root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.ModuleName = factory();
    }
}(typeof self !== 'undefined' ? self : this, function() {
    'use strict';
    // implementation
    return { ... };
}));
```

### 3. `test_browser_modules.js` String Assertions on `index.html`
- `test_browser_modules.js` performs literal text and regex assertions directly against `index.html` (checking for specific DOM IDs like `#variationBanner`, `#btnTogglePgn`, `#topMaterialDisplay`, CSS classes like `.mobile-eval-bar`, `.var-move-btn`, `.diag-missed-banner`, exact function names, and button labels).
- **When editing `index.html`**: NEVER casually rename IDs, delete tested CSS classes, or alter UI function signatures without running `node test_browser_modules.js` to ensure assertions still pass.

### 4. Deterministic Diagnostics
- Move diagnoses, explanations, tags, and template selection **MUST be 100% deterministic** for a given position and engine output.
- **NEVER use `Math.random()`** in diagnostic phrases or variations. Rotations must be seeded by `ply` or position characteristics.

### 5. Static Exchange Evaluation (SEE) Over Geometric Counts
- Tactical safety, hanging-piece blunders, and coach tactical capture hints **MUST** be verified using `SituationRecognizer.staticExchangeEval` (iterative least-valuable-attacker swap-off with x-ray/battery re-scan).
- Naive attacker-vs-defender count heuristics must not be used for material gain assertions.

### 6. Engine Perspective & Centipawn Invariants
- UCI engines report scores (centipawns and mate) from the perspective of the **side to move**.
- White win probability: $WP = \frac{1}{1 + 10^{-cp / 400}}$.
- Mate score bound: $MATE\_SCORE\_CP = 10000$. Mate in $m$ plies is represented as $\pm(10000 - 10 \cdot |m|)$.
- When converting to White POV or displaying evaluations, invert score when side to move is Black.

### 7. Output Contract Compatibility
The UI in `index.html` expects analyzed moves from `BrowserWhyBlunder` / `MoveDiagnostics` to preserve this contract:
```javascript
{
  move_number: 12,
  ply: 24,
  move: "Nxd5",
  player: "White",
  is_white: true,
  quality: "blunder",            // UI quality ('best'|'great'|'good move'|'inaccuracy'|'mistake'|'blunder'|'missed win')
  detailed_quality: "blunder",   // Fine-grained quality ('brilliant'|'great'|'best'|'book'|...)
  evaluation: "+1.20",
  score_cp: 120,
  win_probability: 0.67,
  win_prob_loss: 0.25,
  tags: ["Tactical Fork", "Hanging Piece"],
  notation: "12. Nxd5",
  analysis: {
    best_move: "Be3",
    explanation: "...",
    flaw: "...",
    missed_chance: "...",
    better_line: "...",
    best_evaluation: "+3.70",
    principal_variation: "Be3 O-O d4",
    tags: [...],
    refutation: "c6",
    refutation_variation: "c6 Nc3",
    refutation_from: "c7",
    refutation_to: "c6",
    threats_created: [...]
  }
}
```
Any changes to diagnostic fields must be **additive** (e.g. `evidence`, `confidence`).

---

## 5. Core Subsystems

### A. Engine Analysis Pool (`js/browser-analyzer.js`)
- Spawns a pool of 2 to 6 WebAssembly Web Workers (`navigator.hardwareConcurrency - 1`, capped between 2 and 6).
- Two-Phase Dispatch:
  1. **Phase 1 (Pre-move FEN)**: MultiPV=3 at depth 18. If the played move matches Line 1, evaluation is complete.
  2. **Phase 2 (Post-move refutation FEN)**: If played move was suboptimal, triggers targeted MultiPV=1 search at depth 16 on the post-move FEN to compute the opponent's refutation line.
- Enforces a 20-second execution safety timeout per position to prevent worker hangs.

### B. Move Diagnostics & Evaluation (`js/move-diagnostics.js` & `js/chess-evaluator.js`)
- `MoveDiagnostics.diagnose(options)` is the single entry point used by both Analysis Mode and Coach Mode.
- Win Probability model: $WP = \frac{1}{1 + 10^{-cp / 400}}$.
- Standard loss bands: Inaccuracy ($\Delta WP \ge 0.04$), Mistake ($\Delta WP \ge 0.10$), Blunder ($\Delta WP \ge 0.22$).
- Brilliant moves demand strict criteria: must be the best move, involve a true non-pawn sacrifice (verified by SEE and material deficit), result in a winning position ($WP \ge 0.60$), and be significantly better than the next best alternative ($WP_{secondBest} \le 0.90$, $\Delta WP_{gap} \ge 0.05$).
- Adaptive classification (`ChessEvaluator.classificationThresholds`): Tunes thresholds based on game phase, position sharpness (gap between MultiPV line 1 and lines 2/3), and player Elo.
- Game phase helper: `ChessEvaluator.gamePhase(fen)` calculates remaining non-pawn material to classify `'opening'`, `'middlegame'`, or `'endgame'`.

### C. Tactical Situation Recognizer (`js/situation-recognizer.js`)
- Performs 64-square raycasting to detect:
  - Tactical forks, pins, skewers, discovered attacks.
  - Hanging pieces en prise (corroborated by SEE).
  - Center pawn control, outposts, 7th-rank rook infiltration, passed pawn pushes.
  - King safety flaws and castling forfeits.
- `explainBlunderOrMistake(...)` and `explainGoodMove(...)` generate natural language explanations and tag arrays.

### D. Interactive Sparring Coach (`js/coach-manager.js`)
- Interactive play mode with 4 distinct personas:
  - `pikaru` (1600 Elo - aggressive, passed pawns, fast play)
  - `mcmarty` (800 Elo - beginner-friendly, makes frequent mistakes)
  - `sophy` (1200 Elo - balanced, tactical learner)
  - `mangoose` (2200 Elo - ruthless, positional mastery)
- Features:
  - **"Bait & Spot"**: Intentionally injects tactical blunders at persona-calibrated intervals for the student to punish.
  - **Dual Speech Bubbles**: Real-time coach dialogue and immediate user move feedback.
  - **SEE-Verified Hints**: Hints suggest tactical motifs and target squares without giving away the move, strictly verified by SEE to avoid recommending losing sacrifices.
  - **Learner Model (`errorProfile`)**: Tracks repeated mistakes (`hangingPiece`, `tacticalBlunder`, `kingSafety`, `endgameTechnique`, `openingPrinciple`) across the game to customize feedback and end-of-game summaries.

### E. Analysis Cache (`js/analysis-cache.js`)
- Persists analyses in `localStorage` under `whyblunder_analysis_cache_v1`.
- Normalizes PGN fingerprints (removes headers, comments, clocks, NAGs, recursive variations).
- LRU eviction capping storage at 5 full game analyses.
- Direct Lichess game ID resolution (`https://lichess.org/<id>`).

---

## 6. UI & Styling Architecture (`index.html`)

- **Design System**: Lichess Dark Theme tokens:
  - Canvas: `--lic-bg-canvas: #161512`, Surface: `--lic-bg-surface: #262421`
  - Borders: `--lic-border: #2e2b27`, Hover: `--lic-bg-surface-hover: #312e2a`
  - Text: `--lic-text-primary: #bababa`, Bright: `--lic-text-bright: #ffffff`, Muted: `--lic-text-muted: #62605d`
  - Accents: Blue `--lic-blue: #3692e7`, Green `--lic-green: #629924`, Red `--lic-red: #cc3333`
- **Font Scale**: Strictly 3 tiers:
  - Base: `--lic-fs-base: 0.8125rem` (13px)
  - Small: `--lic-fs-sm: 0.75rem` (12px)
  - Badges: `--lic-fs-badge: 1.25rem` (20px)
- **chess.com Theme Layer (default)**: `body[data-theme="cc"]` remaps the `--lic-*` tokens to a chess.com palette (charcoal + Lichess-orange accent `--cc-cta`, `#d64f00`) and switches desktop to a 2-column shell (board | right panel) with a fixed left sidebar (`#ccSidebar`, forwards clicks to the hidden header controls). The Lichess look remains available via `data-theme="lichess"`; the preference persists in `localStorage` (`whyblunder_theme`, `whyblunder_board_theme`) and is applied by an inline script at `<body>` *before* the board is created. The default board is Lichess brown (`data-board-theme="brown"`); a one-time `whyblunder_board_theme_v2` migration moves the old auto-saved green default to brown. Game Review summary (`#ccReviewSummary`: accuracy via `ChessEvaluator.gameAccuracy/phaseAccuracy`, classification counts, SVG eval graph) opens after analysis. All CC CSS lives in the `CHESS.COM THEME` block at the end of `<style>`; all CC JS in the `CHESS.COM-STYLE UI` block before the `window.*` exports. See `docs/chesscom-ui-plan.md`.
- **Responsive Layout**: Dedicated mobile toolbar (`.mobile-nav-toolbar`), bottom capsule navigation (`.mobile-nav-capsule`), swipeable ticker (`.mobile-move-ticker`), and offcanvas move list (`.mobile-moves-offcanvas`).

---

## 7. Active Roadmap & Improvement Plan

Refer to `docs/move-diagnostics-improvement-plan.md` for ongoing multi-phase work on:
- Phase 0: Test harness & regression corpus (Complete).
- Phase 1: Unified `MoveDiagnostics.diagnose()` core (Complete).
- Phase 2: Evidence-ranked narration rather than fixed priority ladders (In progress).
- Phase 3: Adaptive classification thresholds (Complete in evaluator, being integrated).
- Phase 4: Static Exchange Evaluation & phase-aware endgame detectors (Complete).
- Phase 5: Coach learner model & persona depth dials (Partially landed).
- Phase 6: Adaptive search budgets & boundary re-search.

---

## 8. Common Traps & Gotchas for Agents

| Trap | Reality & Remedy |
| :--- | :--- |
| Looking for `package.json` | There is none. Run `node test_browser_modules.js` and `node test_diagnostics.js`. |
| Adding an npm dependency | Don't. All vendor libs live in `js/` and must remain zero-dependency. |
| Editing `index.html` blindly | `test_browser_modules.js` tests HTML strings/IDs. Run the test suite immediately after editing `index.html`. |
| Assuming Stockfish runs in Node | WASM Stockfish runs in Web Workers in the browser. In Node tests, engine results are stubbed or mocked. |
| Non-deterministic wording | All phrase templates must use deterministic selection (seed by `ply`). |
| Inverting engine scores incorrectly | Stockfish scores are side-to-move relative; always normalize to White POV before calculating win probability or displaying to user. |
