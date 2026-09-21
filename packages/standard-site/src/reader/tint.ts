const NAMED_COLORS = new Set(
  "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen".split(
    " ",
  ),
);

const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const NUMBER = String.raw`[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?`;
const COMPONENT = `(?:${NUMBER}%?|none)`;
const ALPHA = `(?:\\s*(?:,|\\/)\\s*${COMPONENT})?`;
const FUNCTIONAL = new RegExp(
  `^(?:rgba?|hsla?)\\(\\s*${COMPONENT}(?:\\s*,\\s*|\\s+)${COMPONENT}(?:\\s*,\\s*|\\s+)${COMPONENT}${ALPHA}\\s*\\)$`,
  "i",
);

/**
 * An author color the reader may put in a style declaration: a hex, rgb() or
 * hsl() literal, or a named color. Anything else (variables, url(), gradients,
 * expressions) is carried in the block but never drawn.
 */
export function calloutTint(color: string | null): string | null {
  if (!color) return null;
  const trimmed = color.trim();
  if (trimmed.length > 64) return null;
  if (HEX.test(trimmed) || FUNCTIONAL.test(trimmed)) return trimmed;
  return NAMED_COLORS.has(trimmed.toLowerCase()) ? trimmed.toLowerCase() : null;
}
