// The container an insight chart is drawn in (prd-04 Ruling 3; #55). The
// chart is a static SVG serialised by React, so every label in it is already
// escaped; this module wraps it in a whole document for an iframe's
// `srcdoc`, and names the sandbox and the CSP that iframe carries.
//
// The sandbox is empty: no scripts, no same-origin, no forms, no popups,
// no top navigation. The CSP allows nothing to load and only the one inline
// `<style>` below, which is all a static SVG needs. The control is the
// `<meta>` inside the document, which every browser applies. The iframe's
// `csp` attribute (embedded enforcement, Chromium only) is belt-and-braces,
// not something to rely on.

export const CHART_SANDBOX = ''

export const CHART_CSP = "default-src 'none'; style-src 'unsafe-inline'"

// The document's only style: no margins, and the SVG fills the frame, which
// ChartView sizes to the viewBox's aspect ratio.
const CHART_STYLE =
  'html,body{margin:0;height:100%;overflow:hidden;background:transparent}' +
  'svg{display:block;width:100%;height:100%}'

/** A whole HTML document holding `svgMarkup`, for an iframe's `srcdoc`. */
export function chartSrcDoc(svgMarkup: string): string {
  return (
    '<!doctype html><html><head>' +
    '<meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${CHART_CSP}">` +
    `<style>${CHART_STYLE}</style>` +
    `</head><body>${svgMarkup}</body></html>`
  )
}

// The iframe cannot read the app's CSS variables, so the chart's colours
// are the token values from client/styles/App.css, copied here. Each names
// its token; change it there and here together.
export const CHART_COLORS = {
  // --color-ink
  ink: '#2B2224',
  // --color-ink-muted
  muted: '#8A5A70',
  // --color-ink-faint
  faint: '#C9A0B3',
  // --dv-divider (--color-divider)
  divider: '#FBDDE7',
  // --dv-border (--color-line)
  line: '#F7C9D8',
  // --color-surface
  surface: '#FFFFFF',
} as const

// One colour per series, in order, then repeating: --dv-pink, --dv-rose,
// --color-ok, --color-warn, --dv-deep, --color-ink-muted, --dv-shadow,
// --color-ink-faint.
export const CHART_SERIES_COLORS = [
  '#FF5C9E',
  '#B81E63',
  '#3E9A6E',
  '#D9893A',
  '#E0297A',
  '#8A5A70',
  '#FF9CC4',
  '#C9A0B3',
] as const

// --font-sans. The sandboxed document cannot load the app's web fonts, so
// this falls through to the system face unless DM Sans is installed.
export const CHART_FONT = "'DM Sans Variable', system-ui, sans-serif"
