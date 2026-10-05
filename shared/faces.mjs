// Crew's faces: the Critters. One little clay character per icon (crown, headset, bunny ears…),
// each with its own body shape and colour, tiny arms and feet, and a face that shows what the
// agent is doing. Shared by the Crew window, the Android app and the app icons. Pure data and
// pure functions that return SVG markup, no I/O.
//
// The states, and how they move in the window (core of the CSS is in hub/web/app.css):
//   idle     dozing: eyes shut, little "o" mouth, floating z's, slow breathing
//   working  five jumping jacks (each pose held a beat), then a tired whoosh, on a loop
//   asking   one hand up, eyes brimming with tears, worried brows: it needs an answer
//   done     waves, bobs, then a big happy hop with sparkles
//   limit    the plan's 5-hour or weekly usage limit is reached: squeezed eyes, streaming tears
// "smile" is the awake, friendly face of the app icon and the icon pickers.
// With { motion: false } (the phone app, which can't run CSS) each state is one still pose.

/** The agent states a face can show. */
export const STATES = Object.freeze(["idle", "working", "asking", "done", "limit"]);
/** Kept for older callers. */
export const MOODS = STATES;

/** The 25 Critters, in the order the pickers show them: body shape and colour per icon. */
export const CRITTERS = Object.freeze({
  crown: { label: "Crown", shape: "circle", color: "#E9A23B" },
  bulb: { label: "Bulb", shape: "squircle", color: "#7D6CF0" },
  antenna: { label: "Antenna", shape: "hex", color: "#3F7EF6" },
  sprout: { label: "Sprout", shape: "triangle", color: "#33B07A" },
  heart: { label: "Heart", shape: "heart", color: "#EE6A8F" },
  hardhat: { label: "Hard hat", shape: "circle", color: "#F07B3D" },
  gradcap: { label: "Grad cap", shape: "capsule", color: "#1BA6B6" },
  headphones: { label: "Headphones", shape: "bean", color: "#5B6B8C" },
  beanie: { label: "Beanie", shape: "circle", color: "#E0574F" },
  cap: { label: "Cap", shape: "squircle", color: "#4FB3E8" },
  halo: { label: "Halo", shape: "cloud", color: "#B9A3E8" },
  bow: { label: "Bow", shape: "bean", color: "#F28FB0" },
  flowers: { label: "Flowers", shape: "capsule", color: "#8CC63F" },
  star: { label: "Star", shape: "diamond", color: "#4B4FD8" },
  tophat: { label: "Top hat", shape: "squircle", color: "#8E4FA0" },
  wizard: { label: "Wizard", shape: "triangle", color: "#2F5FB8" },
  chef: { label: "Chef", shape: "circle", color: "#E8876B" },
  cat: { label: "Cat ears", shape: "bean", color: "#E58B3A" },
  bunny: { label: "Bunny ears", shape: "capsule", color: "#A68FE0" },
  glasses: { label: "Glasses", shape: "hex", color: "#3DBFA0" },
  headset: { label: "Headset", shape: "diamond", color: "#F2665A" },
  bandana: { label: "Bandana", shape: "cloud", color: "#D4A017" },
  party: { label: "Party hat", shape: "triangle", color: "#D44FB0" },
  cowboy: { label: "Cowboy", shape: "squircle", color: "#B07A55" },
  propeller: { label: "Propeller", shape: "bean", color: "#2EC4C4" },
});

/** The icon names, in the order the pickers show them. */
export const ICON_NAMES = Object.freeze(Object.keys(CRITTERS));

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
 * @param {string} agent
 * @param {string | null} [icon]
 * @returns {string}
 */
export function iconFor(agent, icon) {
  if (icon && CRITTERS[icon]) return icon;
  if (DEFAULT_ICONS[agent]) return DEFAULT_ICONS[agent];
  const spare = ICON_NAMES.slice(AGENTS.length);
  let h = 0;
  for (const ch of String(agent)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return spare[h % spare.length];
}

/** The app icon: five Critters lined up on a round badge (Fahim's pick, 2026-10-06). */
export const APP_ICON = Object.freeze({
  pick: Object.freeze(["crown", "headset", "bandana", "tophat", "antenna"]),
  background: "#F1ECE1",
});

// ---- drawing

const DARK = "#2a211c";
const TEAR = "#8fd3ff";

/** Blend a #rrggbb colour toward another by t (0..1). */
function mix(hex, to, t) {
  const a = parseInt(hex.slice(1), 16);
  const b = parseInt(to.slice(1), 16);
  const ch = (s) => Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t);
  return "#" + ((1 << 24) + (ch(16) << 16) + (ch(8) << 8) + ch(0)).toString(16).slice(1);
}

/** Each body: outline, eye line, where a hat sits, and half its width at the waist. */
const SHAPES = {
  circle: { eyeY: 55, top: 22, w: 33, body: (f) => `<circle cx="50" cy="56" r="32" ${f}/>` },
  squircle: {
    eyeY: 55,
    top: 23,
    w: 33,
    body: (f) => `<rect x="18" y="23" width="64" height="63" rx="24" ${f}/>`,
  },
  hex: {
    eyeY: 56,
    top: 24,
    w: 30,
    body: (f) =>
      `<path d="M50 24 78 40v32L50 88 22 72V40Z" stroke-linejoin="round" stroke-width="9" ${f}/>`,
  },
  triangle: {
    eyeY: 66,
    top: 28,
    w: 30,
    body: (f) => `<path d="M50 28 82 84H18Z" stroke-linejoin="round" stroke-width="11" ${f}/>`,
  },
  heart: {
    eyeY: 53,
    top: 33,
    w: 33,
    body: (f) =>
      `<path d="M50 87C22 67 14 53 19 40c5-13 23-15 31-2 8-13 26-11 31 2 5 13-3 27-31 47Z" ${f}/>`,
  },
  diamond: {
    eyeY: 56,
    top: 21,
    w: 30,
    body: (f) =>
      `<rect x="28" y="34" width="44" height="44" rx="13" transform="rotate(45 50 56)" ${f}/>`,
  },
  capsule: {
    eyeY: 51,
    top: 17,
    w: 23,
    body: (f) => `<rect x="27" y="17" width="46" height="71" rx="23" ${f}/>`,
  },
  cloud: {
    eyeY: 61,
    top: 31,
    w: 34,
    body: (f) =>
      `<path d="M31 85c-10 0-16-7-16-15 0-8 6-14 14-14 1-12 10-21 21-21s20 9 21 21c8 0 14 6 14 14 0 8-6 15-16 15Z" ${f}/>`,
  },
  bean: {
    eyeY: 52,
    top: 20,
    w: 30,
    body: (f) =>
      `<path d="M50 20c19 0 30 15 30 33 0 21-12 33-30 33S20 74 20 53c0-18 11-33 30-33Z" ${f}/>`,
  },
};

/** The body colour also strokes the triangle and hexagon, which rounds their corners. */
const paint = (shape, c) =>
  shape === "triangle" || shape === "hex" ? `fill="${c}" stroke="${c}"` : `fill="${c}"`;
const hi = (x, y, rx = 3, ry = 1.6) =>
  `<ellipse cx="${x}" cy="${y}" rx="${rx}" ry="${ry}" fill="#fff" opacity=".55"/>`;
const starPoints = (cx, cy, R, r) =>
  Array.from({ length: 10 }, (_, i) => {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const d = i % 2 ? r : R;
    return `${(cx + d * Math.cos(a)).toFixed(1)},${(cy + d * Math.sin(a)).toFixed(1)}`;
  }).join(" ");
const flower = (x, y, petal) =>
  [0, 72, 144, 216, 288]
    .map((deg) => {
      const a = (deg * Math.PI) / 180;
      return `<circle cx="${(x + 3.6 * Math.cos(a)).toFixed(1)}" cy="${(y + 3.6 * Math.sin(a)).toFixed(1)}" r="3" fill="${petal}"/>`;
    })
    .join("") + `<circle cx="${x}" cy="${y}" r="2.4" fill="#F4C54A"/>`;

/** Each icon's prop: what goes behind the body (ears) and what goes in front. */
function prop(icon, t, y, body) {
  const ear = mix(body, "#ffffff", 0.3);
  switch (icon) {
    case "crown":
      return {
        front: `<path d="M36 ${t + 3}l2-14 6 8 6-11 6 11 6-8 2 14Z" fill="#F4C54A" stroke="#D9A42A" stroke-width="1.5" stroke-linejoin="round"/><circle cx="50" cy="${t - 1}" r="2.2" fill="#E2546A"/>${hi(42, t - 2, 2.5, 1.2)}`,
      };
    case "bulb":
      return {
        front: `<circle cx="50" cy="${t - 15}" r="12" fill="#FFE27A" opacity=".35"/><rect x="46" y="${t - 8}" width="8" height="6" rx="1.5" fill="#9A8F86"/><circle cx="50" cy="${t - 15}" r="7.5" fill="#FFD84D"/>${hi(47, t - 18, 2.4, 1.4)}`,
      };
    case "antenna":
      return {
        front: `<path d="M50 ${t + 1}V${t - 12}" stroke="#3b2f2a" stroke-width="2.5" stroke-linecap="round"/><circle cx="50" cy="${t - 15}" r="4.6" fill="#E2546A"/>${hi(48.5, t - 16.5, 1.6, 1)}`,
      };
    case "sprout":
      return {
        front: `<path d="M50 ${t + 1}V${t - 10}" stroke="#2E8B57" stroke-width="3" stroke-linecap="round"/><ellipse cx="44" cy="${t - 13}" rx="7" ry="4.2" fill="#62CF90" transform="rotate(-25 44 ${t - 13})"/><ellipse cx="56" cy="${t - 13}" rx="7" ry="4.2" fill="#62CF90" transform="rotate(25 56 ${t - 13})"/>`,
      };
    case "heart":
      return {
        front: `<path transform="translate(59 ${t - 9}) scale(.85)" d="M10 18C3 13 0 9 1 6c1-4 6-5 9-1 3-4 8-3 9 1 1 3-2 7-9 12Z" fill="#E2546A" stroke="#fff" stroke-width="2" stroke-linejoin="round"/>`,
      };
    case "hardhat":
      return {
        front: `<path d="M30 ${t + 5}c0-12 9-18 20-18s20 6 20 18Z" fill="#F4BC3B"/><rect x="24" y="${t + 3}" width="52" height="6" rx="3" fill="#DFA024"/>${hi(41, t - 6, 5, 2)}`,
      };
    case "gradcap":
      return {
        front: `<path d="M36 ${t + 1}v6c8 5 20 5 28 0v-6Z" fill="#2f2a33"/><path d="M24 ${t - 3} 50 ${t - 12} 76 ${t - 3} 50 ${t + 6}Z" fill="#3a343f"/><path d="M71 ${t - 4}v11" stroke="#F4C54A" stroke-width="2"/><circle cx="71" cy="${t + 8}" r="2.3" fill="#F4C54A"/>`,
      };
    case "headphones":
      return {
        front: `<path d="M23 ${y - 1}a27 27 0 0 1 54 0" fill="none" stroke="#3b2f2a" stroke-width="4"/><rect x="16" y="${y - 7}" width="11" height="17" rx="5.5" fill="#E2546A"/><rect x="73" y="${y - 7}" width="11" height="17" rx="5.5" fill="#E2546A"/>${hi(20, y - 3, 1.6, 3)}`,
      };
    case "beanie":
      return {
        front: `<path d="M28 ${t + 8}c0-15 10-21 22-21s22 6 22 21Z" fill="#3D6FB6"/><rect x="25" y="${t + 3}" width="50" height="9" rx="4.5" fill="#2F5A99"/><circle cx="50" cy="${t - 14}" r="5" fill="#F4F0E8"/>${hi(40, t - 4, 5, 2)}`,
      };
    case "cap":
      return {
        front: `<path d="M29 ${t + 7}c0-13 9-19 21-19s21 6 21 19Z" fill="#E2546A"/><ellipse cx="70" cy="${t + 7}" rx="15" ry="4.2" fill="#C94457"/><circle cx="50" cy="${t - 12}" r="2.2" fill="#C94457"/>${hi(41, t - 3, 5, 2)}`,
      };
    case "halo":
      return {
        front: `<ellipse cx="50" cy="${t - 11}" rx="17" ry="5" fill="none" stroke="#FFE27A" stroke-width="6" opacity=".35"/><ellipse cx="50" cy="${t - 11}" rx="17" ry="5" fill="none" stroke="#F4C54A" stroke-width="3.2"/>`,
      };
    case "bow":
      return {
        front: `<path d="M50 ${t + 1}l-13-8v16Z M50 ${t + 1}l13-8v16Z" fill="#E2546A" stroke="#E2546A" stroke-width="3" stroke-linejoin="round"/><circle cx="50" cy="${t + 1}" r="3.6" fill="#C94457"/>`,
      };
    case "flowers":
      return {
        front: flower(36, t + 3, "#fff") + flower(50, t - 2, "#FFB3C7") + flower(64, t + 3, "#fff"),
      };
    case "star":
      return {
        front: `<polygon points="${starPoints(50, t - 13, 9, 4)}" fill="#F4C54A" stroke="#F4C54A" stroke-width="2" stroke-linejoin="round"/>${hi(47, t - 16, 1.8, 1)}`,
      };
    case "tophat":
      return {
        front: `<rect x="36" y="${t - 20}" width="28" height="23" rx="3" fill="#2f2a33"/><rect x="36" y="${t - 4}" width="28" height="4.5" fill="#C94457"/><ellipse cx="50" cy="${t + 3}" rx="22" ry="5" fill="#2f2a33"/>${hi(41, t - 15, 2, 4)}`,
      };
    case "wizard":
      return {
        front: `<path d="M53 ${t - 30} 70 ${t + 1}H30Z" fill="#3B3F9E" stroke="#3B3F9E" stroke-width="3" stroke-linejoin="round"/><ellipse cx="50" cy="${t + 2}" rx="25" ry="5" fill="#33378A"/><polygon points="${starPoints(47, t - 10, 3.6, 1.6)}" fill="#F4C54A"/><circle cx="56" cy="${t - 18}" r="1.6" fill="#F4C54A"/>`,
      };
    case "chef":
      return {
        front: `<circle cx="39" cy="${t - 7}" r="9" fill="#FFFDF8"/><circle cx="61" cy="${t - 7}" r="9" fill="#FFFDF8"/><circle cx="50" cy="${t - 12}" r="10.5" fill="#FFFDF8"/><rect x="33" y="${t - 4}" width="34" height="10" rx="3" fill="#FFFDF8" stroke="#E6E0D4" stroke-width="1.2"/>`,
      };
    case "cat":
      return {
        back: `<path d="M27 ${t + 12} 31 ${t - 9} 46 ${t + 4}Z" fill="${ear}" stroke="${ear}" stroke-width="5" stroke-linejoin="round"/><path d="M73 ${t + 12} 69 ${t - 9} 54 ${t + 4}Z" fill="${ear}" stroke="${ear}" stroke-width="5" stroke-linejoin="round"/>`,
        front: `<path d="M32 ${t + 6} 33 ${t - 3} 40 ${t + 3}Z" fill="#ffb3c0"/><path d="M68 ${t + 6} 67 ${t - 3} 60 ${t + 3}Z" fill="#ffb3c0"/>`,
      };
    case "bunny":
      return {
        back: `<ellipse cx="40" cy="${t - 11}" rx="6.5" ry="16" fill="${ear}" transform="rotate(-10 40 ${t - 11})"/><ellipse cx="60" cy="${t - 11}" rx="6.5" ry="16" fill="${ear}" transform="rotate(10 60 ${t - 11})"/>`,
        front: `<ellipse cx="40" cy="${t - 11}" rx="3" ry="10" fill="#ffb3c0" transform="rotate(-10 40 ${t - 11})"/><ellipse cx="60" cy="${t - 11}" rx="3" ry="10" fill="#ffb3c0" transform="rotate(10 60 ${t - 11})"/>`,
      };
    case "glasses":
      return {
        front: `<g fill="#fff" fill-opacity=".2" stroke="#3b2f2a" stroke-width="2.3"><circle cx="40" cy="${y}" r="8"/><circle cx="60" cy="${y}" r="8"/></g><path d="M48 ${y}h4" stroke="#3b2f2a" stroke-width="2.3"/>`,
      };
    case "headset":
      return {
        front: `<path d="M26 ${y - 1}a24 24 0 0 1 48 0" fill="none" stroke="#3b2f2a" stroke-width="3.5"/><rect x="20" y="${y - 6}" width="9" height="14" rx="4.5" fill="#3b2f2a"/><rect x="71" y="${y - 6}" width="9" height="14" rx="4.5" fill="#3b2f2a"/><path d="M75 ${y + 7}q-2 10-14 11" fill="none" stroke="#3b2f2a" stroke-width="2"/><circle cx="60" cy="${y + 18}" r="2.5" fill="#3b2f2a"/>`,
      };
    case "bandana":
      return {
        front: `<path d="M24 ${y - 9}q26-9 52 0v7q-26-9-52 0Z" fill="#C8473A"/><ellipse cx="80" cy="${y - 3}" rx="6" ry="3" fill="#C8473A" transform="rotate(30 80 ${y - 3})"/><ellipse cx="80" cy="${y + 3}" rx="5" ry="2.6" fill="#B23C30" transform="rotate(60 80 ${y + 3})"/><circle cx="40" cy="${y - 9}" r="1.3" fill="#fff"/><circle cx="56" cy="${y - 10}" r="1.3" fill="#fff"/>`,
      };
    case "party":
      return {
        front: `<g transform="rotate(12 50 ${t})"><path d="M50 ${t - 24} 61 ${t + 3}H39Z" fill="#4FB3E8" stroke="#4FB3E8" stroke-width="2" stroke-linejoin="round"/><path d="M45 ${t - 8}h10M43 ${t - 1}h14" stroke="#fff" stroke-width="2.2"/><circle cx="50" cy="${t - 26}" r="3.6" fill="#F4C54A"/></g>`,
      };
    case "cowboy":
      return {
        front: `<path d="M34 ${t + 5}c0-14 6-20 16-20s16 6 16 20Z" fill="#9C6A42"/><rect x="34" y="${t}" width="32" height="4" fill="#5E3B22"/><path d="M16 ${t + 3}q34 14 68 0q-5 9-34 9T16 ${t + 3}Z" fill="#8A5A36"/>`,
      };
    case "propeller":
      return {
        front: `<path d="M30 ${t + 7}c0-13 9-19 20-19s20 6 20 19Z" fill="#F4C54A"/><path d="M50 ${t - 12}c-5 4-7 11-7 19M50 ${t - 12}c5 4 7 11 7 19" fill="none" stroke="#E2546A" stroke-width="3"/><path d="M50 ${t - 12}V${t - 17}" stroke="#3b2f2a" stroke-width="2"/><ellipse cx="42" cy="${t - 18}" rx="8" ry="2.6" fill="#E2546A"/><ellipse cx="58" cy="${t - 18}" rx="8" ry="2.6" fill="#3F7EF6"/>`,
      };
  }
  return { front: "" };
}

const line = (d, w = 2.2) =>
  `<path d="${d}" fill="none" stroke="${DARK}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;

/** Eyes, blush and mouth for a state. y is the eye line. */
function face(state, y, motion) {
  const cheeks = `<ellipse cx="31" cy="${y + 9}" rx="6" ry="3.6" fill="#ff7088" opacity=".38"/><ellipse cx="69" cy="${y + 9}" rx="6" ry="3.6" fill="#ff7088" opacity=".38"/>`;
  const dot = (x, rx, ry) =>
    `<ellipse cx="${x}" cy="${y}" rx="${rx}" ry="${ry}" fill="${DARK}"/><circle cx="${x + 1.4}" cy="${y - ry / 2}" r="${Math.max(1, rx * 0.38)}" fill="#fff"/>`;
  const closed = (q) => line(`M35 ${y + 1}q5 ${q} 10 0M55 ${y + 1}q5 ${q} 10 0`, 2.8);
  switch (state) {
    case "working": {
      // Bright-eyed through the jumping jacks, then a tired whoosh.
      const jump = `${dot(41, 3.8, 4.8)}${dot(59, 3.8, 4.8)}<path d="M45 ${y + 8}q5 6.5 10 0Z" fill="${DARK}"/>`;
      if (!motion) return cheeks + jump;
      const whoosh =
        `<ellipse cx="31" cy="${y + 9}" rx="6.5" ry="4" fill="#ff5a78" opacity=".45"/><ellipse cx="69" cy="${y + 9}" rx="6.5" ry="4" fill="#ff5a78" opacity=".45"/>` +
        line(`M36 ${y + 1}q5 2.5 10 0M54 ${y + 1}q5 2.5 10 0`, 2.6) +
        `<ellipse cx="50" cy="${y + 11}" rx="2.6" ry="2.2" fill="${DARK}"/>` +
        `<g class="puff" fill="none" stroke="#9fb7c9" stroke-width="2" stroke-linecap="round"><path d="M55 ${y + 10}q5-2 9 0"/><path d="M57 ${y + 14}q5-1 10 1"/></g>` +
        `<path class="sweat" d="M72 ${y - 12}q3 4 0 6q-3-2 0-6Z" fill="${TEAR}"/>`;
      return `${cheeks}<g class="ph-jump">${jump}</g><g class="ph-whoosh">${whoosh}</g>`;
    }
    case "asking": {
      // Hand up, eyes brimming: it really wants an answer.
      const wet = (x) =>
        `<ellipse cx="${x}" cy="${y}" rx="4.8" ry="6" fill="${DARK}"/><circle cx="${x + 1.6}" cy="${y - 2.4}" r="2.1" fill="#fff"/><circle cx="${x - 1.6}" cy="${y + 1.8}" r="1" fill="#fff"/><ellipse cx="${x}" cy="${y + 4.6}" rx="4.6" ry="1.9" fill="${TEAR}" opacity=".95"/>`;
      return (
        cheeks +
        `<g class="eyes">${wet(41)}${wet(59)}</g>` +
        line(`M44.5 ${y + 12}q2.75-2.2 5.5 0q2.75 2.2 5.5 0`, 2) +
        line(`M35 ${y - 9}q5-1 9-4.5M65 ${y - 9}q-5-1-9-4.5`, 2) +
        `<circle class="tear" cx="35.5" cy="${y + 7}" r="1.6" fill="${TEAR}"/>`
      );
    }
    case "done": {
      const spark = (x, sy, r, n) =>
        `<path class="spark s${n}" d="M${x} ${sy - r}Q${x} ${sy} ${x + r} ${sy}Q${x} ${sy} ${x} ${sy + r}Q${x} ${sy} ${x - r} ${sy}Q${x} ${sy} ${x} ${sy - r}Z" fill="#F4C54A"/>`;
      return (
        cheeks +
        `<g class="eyes">${closed(-6)}</g>` +
        `<path d="M44 ${y + 8}q6 7 12 0Z" fill="${DARK}"/><path d="M47 ${y + 11}q3 2 6 0" fill="#ff8a8a"/>` +
        (motion
          ? spark(16, y - 16, 8, 1) +
            spark(85, y - 22, 6.5, 2) +
            spark(88, y + 4, 5, 3) +
            spark(12, y + 7, 4.5, 2)
          : "")
      );
    }
    case "limit":
      // Out of usage: eyes squeezed shut, tears streaming, mouth open in a wail.
      return (
        cheeks +
        `<g class="eyes">${line(`M36 ${y - 3}l6 3-6 3M64 ${y - 3}l-6 3 6 3`, 2.6)}</g>` +
        `<path d="M42.5 ${y + 15}q7.5-10 15 0q-7.5 3-15 0Z" fill="${DARK}"/><path d="M46 ${y + 14}q4-2.5 8 0" fill="#ff8a96"/>` +
        line(`M35 ${y - 10}q5-1 9-4M65 ${y - 10}q-5-1-9-4`, 2) +
        `<path d="M38 ${y + 4}q-1.5 7-.5 14M62 ${y + 4}q1.5 7 .5 14" fill="none" stroke="${TEAR}" stroke-width="3.4" stroke-linecap="round" opacity=".9"/>` +
        `<circle class="tear" cx="37.5" cy="${y + 21}" r="2.3" fill="${TEAR}"/><circle class="tear late" cx="62.5" cy="${y + 21}" r="2.3" fill="${TEAR}"/>`
      );
    case "smile":
      return (
        cheeks +
        `<g class="eyes">${dot(41, 3.6, 4.6)}${dot(59, 3.6, 4.6)}</g>` +
        line(`M46 ${y + 9}q4 3.5 8 0`)
      );
    default:
      // Idle: dozing until there is work.
      return (
        cheeks +
        `<g class="eyes">${closed(4)}</g>` +
        `<ellipse cx="50" cy="${y + 10}" rx="2" ry="1.6" fill="${DARK}"/>` +
        `<g class="zz" fill="${DARK}" opacity=".8" font-family="Georgia,serif" font-weight="700"><text x="72" y="${y - 14}" font-size="10">z</text><text x="79" y="${y - 22}" font-size="7">z</text></g>`
      );
  }
}

/** Tiny arms and feet, posed for the state. */
function limbs(sh, color, state, motion) {
  const c = mix(color, "#2a1a10", 0.12);
  const left = 50 - sh.w - 1;
  const right = 50 + sh.w + 1;
  const y = 66;
  const arm = (x, deg, cy = y) =>
    `<ellipse cx="${x}" cy="${cy}" rx="4.4" ry="8" fill="${c}" transform="rotate(${deg} ${x} ${cy})"/>`;
  const feet = `<ellipse class="footL" cx="40" cy="89" rx="7.5" ry="4.5" fill="${c}"/><ellipse class="footR" cx="60" cy="89" rx="7.5" ry="4.5" fill="${c}"/>`;
  if (state === "working") {
    // Jumping jacks: each arm swings from its shoulder, sides to overhead. Whoosh: one arm
    // wipes the brow, the other hangs.
    // A moving arm sits in a group whose box is centred on the shoulder (an unpainted circle
    // sets the box), so CSS can swing it about its centre with no inline style.
    const sy = sh.eyeY + 1;
    const jack = (cls, sx, deg) =>
      motion
        ? `<g class="${cls}"><circle cx="${sx}" cy="${sy}" r="18" fill="none"/><ellipse cx="${sx}" cy="${sy + 8}" rx="4.4" ry="8.5" fill="${c}"/></g>`
        : `<ellipse cx="${sx}" cy="${sy + 8}" rx="4.4" ry="8.5" fill="${c}" transform="rotate(${deg} ${sx} ${sy})"/>`;
    const jacks = `${jack("jackL", left + 4, 14)}${jack("jackR", right - 4, -14)}`;
    if (!motion) return { back: feet, front: jacks };
    const brow = `<ellipse cx="${right - 6}" cy="${sh.eyeY - 9}" rx="4.4" ry="8" fill="${c}" transform="rotate(-62 ${right - 6} ${sh.eyeY - 9})"/>`;
    return {
      back: feet,
      front: `<g class="ph-jump">${jacks}</g><g class="ph-whoosh">${arm(left + 1, 8, y + 3)}${brow}</g>`,
    };
  }
  if (state === "limit")
    return { back: feet, front: arm(left + 1, 6, y + 4) + arm(right - 1, -6, y + 4) };
  if (state === "asking" || state === "done") {
    // One arm up, pivoting at the shoulder so done can wave it.
    const up = `<ellipse cx="${right + 3}" cy="${y - 14}" rx="4.6" ry="8.5" fill="${c}" transform="rotate(28 ${right + 3} ${y - 14})"/>`;
    const wave = motion
      ? `<g class="waveR"><circle cx="${right - 1}" cy="${y - 6}" r="22" fill="none"/>${up}</g>`
      : up;
    return { back: feet, front: arm(left, 24) + wave };
  }
  return { back: feet, front: arm(left, 24) + arm(right, -24) };
}

/** The shading every face uses, defined once inside each SVG so each one stands alone. */
const DEFS =
  `<defs>` +
  `<filter id="crew-soft" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="2.2"/></filter>` +
  `<radialGradient id="crew-shine" cx="34%" cy="26%" r="55%"><stop offset="0" stop-color="#fff" stop-opacity=".7"/><stop offset=".5" stop-color="#fff" stop-opacity=".1"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>` +
  `<radialGradient id="crew-shade" cx="50%" cy="30%" r="80%"><stop offset=".5" stop-color="#2a1a10" stop-opacity="0"/><stop offset="1" stop-color="#2a1a10" stop-opacity=".32"/></radialGradient>` +
  `</defs>`;

/**
 * One Critter as the inside of a 100 × 100 viewBox (no <svg>, no <defs>).
 * @param {string} icon  one of ICON_NAMES
 * @param {string} [state]  one of STATES, or "smile"
 * @param {{ motion?: boolean, ground?: boolean }} [options]
 */
export function critterMarkup(icon, state = "idle", options = {}) {
  const motion = options.motion !== false;
  const ground = options.ground !== false;
  const c = CRITTERS[icon] ?? CRITTERS.crown;
  const sh = SHAPES[c.shape];
  const tint = mix(c.color, "#ffffff", 0.3);
  const p = prop(CRITTERS[icon] ? icon : "crown", sh.top, sh.eyeY, c.color);
  const l = limbs(sh, tint, state, motion);
  const shadow = ground
    ? `<ellipse class="gs" cx="50" cy="93" rx="25" ry="4" fill="#2a1a10" opacity=".16" filter="url(#crew-soft)"/>`
    : "";
  const body =
    sh.body(paint(c.shape, tint)) +
    sh.body(`fill="url(#crew-shade)"`) +
    sh.body(`fill="url(#crew-shine)"`);
  return `${shadow}<g class="bod">${p.back ?? ""}${l.back}${body}${l.front}${face(state, sh.eyeY, motion)}${p.front}</g>`;
}

/**
 * A whole face as an <svg> string. Built only from the fixed drawings above: no outside text
 * reaches it, so it is safe to put in innerHTML.
 * @param {string} icon
 * @param {string} [state]
 * @param {{ motion?: boolean, label?: string }} [options]
 */
export function faceSVG(icon, state = "idle", options = {}) {
  const label = String(options.label ?? CRITTERS[icon]?.label ?? "").replace(/[<>&"]/g, "");
  return `<svg class="critter" viewBox="0 0 100 100" role="img" aria-label="${label}" xmlns="http://www.w3.org/2000/svg">${DEFS}${critterMarkup(icon, state, options)}</svg>`;
}

/** Where the five sit on the app icon: middle (biggest, waving), its sides, then the ends. */
const ICON_SLOTS = [
  { cx: 100, size: 66, state: "done" },
  { cx: 65, size: 54, state: "smile" },
  { cx: 135, size: 54, state: "smile" },
  { cx: 34, size: 44, state: "smile" },
  { cx: 166, size: 44, state: "smile" },
];

/**
 * The app icon as an <svg> string (200 × 200).
 * @param {{ pick?: string[], background?: string | null, round?: boolean, silhouette?: string }} [options]
 *   background null leaves it transparent (Android's adaptive icon foreground); silhouette
 *   paints every figure one colour (the notification icon).
 */
export function appIconSVG(options = {}) {
  const pick = options.pick ?? APP_ICON.pick;
  const bg = options.background === undefined ? APP_ICON.background : options.background;
  const round = options.round !== false;
  const draw = [3, 4, 1, 2, 0]; // back to front
  const figures = draw
    .map((i) => {
      const s = ICON_SLOTS[i];
      if (!pick[i]) return "";
      const x = s.cx - s.size / 2;
      const y = 138 - s.size * 0.9;
      const inner = critterMarkup(pick[i], options.silhouette ? "smile" : s.state, {
        motion: false,
        ground: false,
      });
      return `<svg x="${x}" y="${y}" width="${s.size}" height="${s.size}" viewBox="0 0 100 100" overflow="visible">${inner}</svg>`;
    })
    .join("");
  const back = bg
    ? round
      ? `<circle cx="100" cy="100" r="100" fill="${bg}"/>`
      : `<rect width="200" height="200" fill="${bg}"/>`
    : "";
  const floor = options.silhouette
    ? ""
    : `<ellipse cx="100" cy="138" rx="78" ry="6" fill="#000" opacity=".14" filter="url(#crew-soft)"/>`;
  const tint = options.silhouette
    ? `<filter id="crew-flat"><feFlood flood-color="${options.silhouette}"/><feComposite in2="SourceAlpha" operator="in"/></filter>`
    : "";
  const group = options.silhouette ? `<g filter="url(#crew-flat)">${figures}</g>` : figures;
  return `<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Crew">${DEFS.replace("</defs>", `${tint}</defs>`)}${back}${floor}${group}</svg>`;
}
