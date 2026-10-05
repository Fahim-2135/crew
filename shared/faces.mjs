// Crew's pixel faces: one 16×16 character per agent, shared by the Crew window, the Android app,
// the app icons and the Claude Code mod. Pure data and pure functions, no I/O.
//
// The icon (an accessory: crown, hard hat, cat ears…) says who the agent is; the body colour
// says what it is doing: grey idle, blue working, orange needs you, green done. Faces v2:
// outlined, lit from the upper left, shaded at the rim, with eye sparkle and blush; the
// working face strains and then breathes out ("whoo"), like lifting a weight.

/** The round body every face shares. `B` is body. */
const BODY = [
  "................",
  "................",
  "................",
  "................",
  "....BBBBBBBB....",
  "..BBBBBBBBBBBB..",
  ".BBBBBBBBBBBBBB.",
  ".BBBBBBBBBBBBBB.",
  "BBBBBBBBBBBBBBBB",
  "BBBBBBBBBBBBBBBB",
  "BBBBBBBBBBBBBBBB",
  "BBBBBBBBBBBBBBBB",
  ".BBBBBBBBBBBBBB.",
  ".BBBBBBBBBBBBBB.",
  "..BBBBBBBBBBBB..",
  "....BBBBBBBB....",
];

/** The four states. */
export const MOODS = Object.freeze(["idle", "working", "asking", "done"]);

/** Body tones per state: B body, S shade, H highlight, O outline. */
export const MOOD_COLORS = Object.freeze({
  idle: { B: "#A7AFBC", S: "#7F8796", H: "#D6DAE2", O: "#3B404B" },
  working: { B: "#5B97FF", S: "#3A74DB", H: "#AFCBFF", O: "#1D3F86" },
  asking: { B: "#FFAA33", S: "#E08200", H: "#FFD9A1", O: "#7A4500" },
  done: { B: "#46D98A", S: "#25AB66", H: "#AAF0C8", O: "#145C37" },
});

/** Every other colour a face uses. */
const INK = Object.freeze({
  E: "#1B1B22",
  W: "#FFFFFF",
  P: "#FF8FB1",
  Q: "#FFC2D4",
  Y: "#FFC83D",
  y: "#C98B00",
  R: "#FF4D6D",
  r: "#B8203F",
  L: "#2F9E44",
  l: "#8CE99A",
  K: "#2A2A33",
  k: "#5A5A70",
  C: "#3BC9DB",
  c: "#1C8A99",
  g: "#FFF3B0",
  V: "#9775FA",
  U: "#5F3DC4",
  N: "#9C6B3A",
  n: "#5C3A1A",
  w: "#DCE4EE",
});

/**
 * The 25 icons: `[row, 16-character overlay]`; "." leaves the cell as it is, and B, S, O
 * paint in the body's own tones (for ears). The first eight are what the first eight wear.
 */
const ICONS = Object.freeze({
  crown: [
    [1, "....Y..YY..Y...."],
    [2, "....YY.YY.YY...."],
    [3, "....YYYYYYYY...."],
    [4, "....yYRYYCYy...."],
  ],
  bulb: [
    [0, "......gggg......"],
    [1, ".....gWgggg....."],
    [2, "......gggg......"],
    [3, ".......kk......."],
  ],
  antenna: [
    [0, ".......RR......."],
    [1, ".......Rr......."],
    [2, ".......kk......."],
    [3, ".......kk......."],
  ],
  sprout: [
    [0, "....lll..lll...."],
    [1, ".....lLLLLl....."],
    [2, ".......LL......."],
    [3, ".......LL......."],
  ],
  heart: [
    [0, ".....RR..RR....."],
    [1, "....RWRRRRRR...."],
    [2, ".....RRRRRR....."],
    [3, "......RRRR......"],
  ],
  hardhat: [
    [1, ".......yy......."],
    [2, ".....YYYYYY....."],
    [3, "....YYWYYYYY...."],
    [4, "..yyyyyyyyyyyy.."],
  ],
  gradcap: [
    [1, "..KKKKKKKKKKKK.."],
    [2, "....KKKKKKKKY..."],
    [3, ".....KKKKKK.Y..."],
    [4, "............Y..."],
  ],
  headphones: [
    [2, "....kkkkkkkk...."],
    [3, "...k........k..."],
    [4, "..k..........k.."],
    [5, ".k............k."],
    [6, ".k............k."],
    [7, "CC............CC"],
    [8, "Kc............cK"],
    [9, "Kc............cK"],
    [10, "CC............CC"],
  ],
  beanie: [
    [1, ".......WW......."],
    [2, ".....VVVVVV....."],
    [3, "....VVVVVVVV...."],
    [4, "..VVVVVVVVVVVV.."],
  ],
  cap: [
    [2, ".....CCCCCC....."],
    [3, "....CCCCCCCC...."],
    [4, "..ccCCCCCCCCCCCC"],
  ],
  halo: [
    [0, ".....YYYYYY....."],
    [1, "....Y......Y...."],
    [2, ".....YYYYYY....."],
  ],
  bow: [
    [3, "..PPP..........."],
    [4, "..PWP..........."],
    [5, "..PPP..........."],
  ],
  flowers: [
    [2, ".......l.l......"],
    [3, "........Y......."],
    [4, "..CCCCCCCCCCCC.."],
  ],
  star: [
    [0, ".......Y........"],
    [1, "......YYY......."],
    [2, ".......Y........"],
    [3, ".......k........"],
  ],
  tophat: [
    [0, ".....KKKKKK....."],
    [1, ".....KKKKKK....."],
    [2, ".....RRRRRR....."],
    [3, "...KKKKKKKKKK..."],
  ],
  wizard: [
    [0, "........V......."],
    [1, ".......VVY......"],
    [2, "......VVVVV....."],
    [3, ".....VYVVVVV...."],
    [4, "...UUUUUUUUUU..."],
  ],
  chef: [
    [0, ".....WW.WW......"],
    [1, "....WWWWWWWW...."],
    [2, "....WWWWWWWW...."],
    [3, ".....wwwwww....."],
  ],
  cat: [
    [1, "...O........O..."],
    [2, "...OO......OO..."],
    [3, "...OQO....OQO..."],
    [4, "...OBB....BBO..."],
  ],
  bunny: [
    [0, "....OO....OO...."],
    [1, "....OQ....QO...."],
    [2, "....OQ....QO...."],
    [3, "....OB....BO...."],
  ],
  glasses: [
    [7, "...KKKK..KKKK..."],
    [8, "...K..KKKK..K..."],
    [9, "...K..K..K..K..."],
    [10, "...KKKK..KKKK..."],
  ],
  headset: [
    [2, "....kkkkkkkk...."],
    [3, "...k........k..."],
    [4, "..k..........k.."],
    [5, ".k............k."],
    [6, ".k............k."],
    [7, "KK.............."],
    [8, "KK.............."],
    [9, "Kk.............."],
    [10, ".k.............."],
    [11, "..kkkR.........."],
  ],
  bandana: [
    [5, "..RRRRRRRRRRRR.."],
    [6, ".RRRRRRRRRRRRRRr"],
    [7, "..............rR"],
  ],
  party: [
    [0, ".......Y........"],
    [1, ".......PC......."],
    [2, "......CPCP......"],
    [3, ".....PCPCPC....."],
  ],
  cowboy: [
    [1, ".....NNNNNN....."],
    [2, ".....NnnnnN....."],
    [3, ".NNNNNNNNNNNNNN."],
    [4, "..nn........nn.."],
  ],
  propeller: [
    [0, "....RRR.CCC....."],
    [1, ".......k........"],
    [2, ".....YRYCYR....."],
    [3, "....RYCYRYCY...."],
    [4, "...yyyyyyyyyy..."],
  ],
});

/** The icon names, in the order the pickers show them. */
export const ICON_NAMES = Object.freeze(Object.keys(ICONS));

/** What the first eight wear unless the user picks another. */
export const DEFAULT_ICONS = Object.freeze({
  ceo: "crown",
  product: "bulb",
  engineering: "antenna",
  growth: "sprout",
  social: "heart",
  ops: "hardhat",
  learning: "gradcap",
  coder: "headphones",
});

/** The agents that have faces from the start, in the order the team is shown. */
export const AGENTS = Object.freeze(Object.keys(DEFAULT_ICONS));

/**
 * The icon an agent wears: the one picked for it, else its own, else (for agents created
 * without one) one of the others, picked from its name so it is the same on every screen.
 * "crew" (the app icon's face) wears none.
 * @param {string} agent
 * @param {string | null} [icon]
 * @returns {string | null}
 */
export function iconFor(agent, icon) {
  if (icon && ICONS[icon]) return icon;
  if (DEFAULT_ICONS[agent]) return DEFAULT_ICONS[agent];
  if (agent === "crew") return null;
  const spare = ICON_NAMES.slice(AGENTS.length);
  let h = 0;
  for (const ch of String(agent)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return spare[h % spare.length];
}

const EYES_OPEN = [
  [8, 4, "E"],
  [8, 5, "E"],
  [9, 4, "E"],
  [9, 5, "E"],
  [8, 10, "E"],
  [8, 11, "E"],
  [9, 10, "E"],
  [9, 11, "E"],
  [8, 4, "W"],
  [8, 10, "W"],
];
const EYES_SHUT = [
  [9, 4, "E"],
  [9, 5, "E"],
  [9, 10, "E"],
  [9, 11, "E"],
];

/** Eyes and mouth: [row, col, ink]; "O" is the body's outline tone. */
const FACES = {
  idle: [
    [12, 7, "E"],
    [12, 8, "E"],
    [11, 2, "P"],
    [11, 13, "P"],
  ],
  asking: [
    [6, 3, "O"],
    [6, 4, "O"],
    [6, 11, "O"],
    [6, 12, "O"],
    [11, 7, "E"],
    [11, 8, "E"],
    [12, 7, "E"],
    [12, 8, "E"],
  ],
  done: [
    [8, 5, "E"],
    [8, 11, "E"],
    [9, 4, "E"],
    [9, 6, "E"],
    [9, 10, "E"],
    [9, 12, "E"],
    [11, 5, "E"],
    [11, 10, "E"],
    [12, 6, "E"],
    [12, 7, "E"],
    [12, 8, "E"],
    [12, 9, "E"],
    [11, 2, "P"],
    [11, 3, "P"],
    [11, 12, "P"],
    [11, 13, "P"],
  ],
  // Working, part 1: straining, like lifting a weight: squeezed eyes, gritted teeth, sweat.
  strain: [
    [7, 4, "E"],
    [8, 5, "E"],
    [9, 4, "E"],
    [7, 11, "E"],
    [8, 10, "E"],
    [9, 11, "E"],
    [6, 3, "O"],
    [6, 4, "O"],
    [6, 11, "O"],
    [6, 12, "O"],
    [11, 5, "E"],
    [11, 6, "E"],
    [11, 7, "E"],
    [11, 8, "E"],
    [11, 9, "E"],
    [11, 10, "E"],
    [12, 5, "E"],
    [12, 6, "W"],
    [12, 7, "W"],
    [12, 8, "W"],
    [12, 9, "W"],
    [12, 10, "E"],
    [13, 5, "E"],
    [13, 6, "E"],
    [13, 7, "E"],
    [13, 8, "E"],
    [13, 9, "E"],
    [13, 10, "E"],
    [5, 13, "C"],
    [6, 13, "C"],
    [10, 2, "P"],
    [10, 13, "P"],
  ],
  // Working, part 2: the breath out ("whoo"): eyes ease, lips purse, a puff of air.
  exhale: [
    [8, 4, "E"],
    [8, 5, "E"],
    [8, 10, "E"],
    [8, 11, "E"],
    [11, 8, "E"],
    [12, 7, "E"],
    [12, 9, "E"],
    [13, 8, "E"],
    [11, 2, "P"],
    [11, 13, "P"],
    [12, 15, "w"],
    [14, 14, "w"],
    [14, 15, "w"],
  ],
};

/**
 * The eyes and mouth for a state at one animation frame. Frames tick about twice a second:
 * the working face holds each part for two frames (strain, then whoo), and idle and asking
 * faces blink every ninth frame.
 */
function expression(mood, frame) {
  if (mood === "working")
    return Math.floor((frame - 1) / 2) % 2 === 0 ? FACES.strain : FACES.exhale;
  if (mood === "done") return FACES.done;
  const eyes = frame % 9 === 0 ? EYES_SHUT : EYES_OPEN;
  return [...eyes, ...(FACES[mood] ?? FACES.idle)];
}

const isBody = (r, c) => r >= 0 && r < 16 && c >= 0 && c < 16 && BODY[r][c] === "B";

/**
 * A face as a 16×16 grid of colours, `null` where the background shows through.
 * @param {string} agent
 * @param {string} mood      unknown states render as idle
 * @param {number} [frame]   animation frame; 1 is a still, eyes-open frame
 * @param {string | null} [icon]  an icon from ICON_NAMES, overriding the agent's own
 * @returns {Array<Array<string | null>>}
 */
export function faceGrid(agent, mood, frame = 1, icon = null) {
  const state = MOOD_COLORS[mood] ? mood : "idle";
  const tone = MOOD_COLORS[state];
  const grid = [];
  for (let r = 0; r < 16; r++) {
    const row = [];
    for (let c = 0; c < 16; c++) {
      let v = null;
      if (isBody(r, c)) {
        // Shade the lower rim; outline every edge.
        const low = !isBody(r + 1, c) || !isBody(r + 2, c);
        const side = r > 9 && (!isBody(r, c + 1) || !isBody(r, c + 2));
        v = low || side ? tone.S : tone.B;
        if (!isBody(r - 1, c) || !isBody(r, c - 1) || !isBody(r, c + 1) || !isBody(r + 1, c))
          v = tone.O;
      }
      row.push(v);
    }
    grid.push(row);
  }
  for (const [r, c] of [
    [5, 4],
    [5, 5],
    [6, 3],
  ])
    grid[r][c] = tone.H; // the shine
  for (const [r, c, ink] of expression(state, frame)) grid[r][c] = ink === "O" ? tone.O : INK[ink];
  const name = iconFor(agent, icon);
  for (const [r, overlay] of name ? ICONS[name] : []) {
    [...overlay].forEach((ch, c) => {
      if (ch === ".") return;
      grid[r][c] = ch === "B" || ch === "S" || ch === "O" ? tone[ch] : (INK[ch] ?? null);
    });
  }
  return grid;
}

/**
 * Fold a face into terminal half-block cells: each cell is the upper-half block "▀" whose
 * foreground is the top pixel and background the bottom pixel, so 16×16 pixels fit in
 * 16 columns × 8 rows with square pixels.
 * @param {Array<Array<string | null>>} grid
 * @returns {Array<Array<{ top: string | null, bottom: string | null }>>}
 */
export function halfBlocks(grid) {
  const rows = [];
  for (let r = 0; r < grid.length; r += 2) {
    rows.push(grid[r].map((top, c) => ({ top, bottom: grid[r + 1]?.[c] ?? null })));
  }
  return rows;
}
