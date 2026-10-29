// A quiet wash of colour behind Today that follows the sun and the weather.
// Much calmer than the live sky: two soft glows whose colours drift through the day.
// The CSS mixes them at low strength over the page colour, so light and dark both stay readable.

// Colours by sun elevation (degrees): [elevation, [top glow, bottom glow]]. Morning and evening differ.
const TINT_RISING = [
  [-12, ['#4a5aa8', '#2c3570']],  // night: indigo
  [-4, ['#8a6fc4', '#3f4a94']],   // first light: lavender
  [2, ['#f08a7e', '#9a7fd0']],    // sunrise: rose and lilac
  [10, ['#f5b469', '#e79a8a']],   // early morning: soft gold
  [30, ['#8cc4ea', '#f2c97e']],   // morning: clear blue, warm low light
  [55, ['#7bb6e6', '#a9d4ee']],   // midday: blue
];
const TINT_SETTING = [
  [-12, ['#4a5aa8', '#2c3570']],
  [-4, ['#7a5cb8', '#3c4590']],   // dusk: violet
  [2, ['#e7728a', '#8a6cc8']],    // sunset: rose and violet
  [10, ['#f39a52', '#e6788c']],   // golden hour: amber
  [30, ['#f2bf6e', '#8cc4ea']],   // afternoon: warm gold
  [55, ['#7bb6e6', '#a9d4ee']],
];

// How the weather pulls the colours: towards a shade, by how much.
const TINT_WEATHER = {
  partlycloudy: ['#a3acb8', 0.25],
  cloudy: ['#98a2ae', 0.6],
  fog: ['#b7bdc4', 0.65],
  rainy: ['#5f86a6', 0.7],
  pouring: ['#4f7090', 0.8],
  lightning: ['#5a5f86', 0.6],
  'lightning-rainy': ['#4d5580', 0.7],
  snowy: ['#c9d7e6', 0.6],
  'snowy-rainy': ['#9fb4c8', 0.6],
  hail: ['#8fa0b4', 0.6],
  windy: ['#9fb8c4', 0.2],
  'windy-variant': ['#98a6b2', 0.4],
  exceptional: ['#a08a8a', 0.4],
};

const tintRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const tintHex = (rgb) => '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
const tintMix = (a, b, t) => {
  const x = tintRgb(a);
  const y = tintRgb(b);
  return tintHex(x.map((v, i) => v + (y[i] - v) * t));
};

function tintSample(table, elevation) {
  if (elevation <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    const [e1, c1] = table[i];
    if (elevation <= e1) {
      const [e0, c0] = table[i - 1];
      const t = (elevation - e0) / (e1 - e0);
      return c0.map((c, j) => tintMix(c, c1[j], t));
    }
  }
  return table[table.length - 1][1];
}

/** elevation (deg), rising (bool), condition (HA weather state) -> { a, b } hex colours. */
export function todayTint({ elevation = 30, rising = true, condition = '' } = {}) {
  let [a, b] = tintSample(rising ? TINT_RISING : TINT_SETTING, elevation);
  const fx = TINT_WEATHER[condition];
  if (fx) {
    // Under cloud at night the shade is darker, so it doesn't glow grey in the dark.
    const shade = elevation < -4 ? tintMix(fx[0], '#2c3570', 0.5) : fx[0];
    a = tintMix(a, shade, fx[1]);
    b = tintMix(b, shade, fx[1]);
  }
  return { a, b };
}
