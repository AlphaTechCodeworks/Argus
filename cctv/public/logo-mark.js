// The Guardian Eye, drawn in the page so that it can play again (shell.js). Made from the animated
// mark on the sign-in page (login.html) by a one-off script on 2026-10-14; the still one shows instead
// to anyone who has asked their system for less motion.

/** How often the mark plays again while the page is on screen (Mike, 2026-10-14). */
export const MARK_REPLAY_MS = 60_000

let copies = 0

/** The mark as an inline SVG, its ids its own (the sidebar and the phone bar both have one). */
export function markSvg(className) {
  const n = ++copies
  return `<svg class="${className}" viewBox="0 0 128 128" aria-hidden="true" focusable="false"><style>.mk-still{display:none}@media(prefers-reduced-motion:reduce){.mk-motion{display:none}.mk-still{display:inline}}</style><rect width="128" height="128" rx="28" fill="#0A192F"/><g transform="translate(-3.2,-3.2) scale(1.05)"><g class="mk-still"><defs><clipPath id="a-guardian-eye-eye-clip-${n}"><path d="M32,62 C48,41 80,41 96,62 C80,81 48,81 32,62 Z"/></clipPath></defs><g fill="none" transform="rotate(0 64 62)" opacity="0"> <circle cx="64" cy="62" r="25" stroke="#00F5FF" stroke-opacity=".07" stroke-width="10"/> <circle cx="64" cy="62" r="23" stroke="#00AEEF" stroke-width="4"/> <path d="M64,45 A17,17 0 0 1 81,62" stroke="#00F5FF" stroke-width="3" stroke-linecap="round"/></g><path d="M64,15 L102,31 L102,65 C102,88 82,103 64,113 C46,103 26,88 26,65 L26,31 L64,15 Z" fill="#00AEEF" fill-opacity=".045" stroke="#00AEEF" stroke-width="5.5" stroke-linejoin="round" stroke-linecap="round" pathLength="1" stroke-dasharray="1" stroke-dashoffset="0" opacity="1"/><g opacity="1"> <path d="M32,62 C48,41 80,41 96,62 C80,81 48,81 32,62 Z" fill="#FFFFFF"/> <g clip-path="url(#a-guardian-eye-eye-clip-${n})">  <circle cx="64" cy="62" r="14" fill="#00AEEF"/>  <circle cx="64" cy="62" r="10" fill="#0A192F"/>  <path d="M61,57 L69,62 L61,67Z" fill="#00F5FF"/>  <circle cx="69" cy="56" r="1.5" fill="#FFFFFF" opacity=".85"/>  <path d="M64,45V79" stroke="#00F5FF" stroke-width="2" opacity="0"/> </g></g><circle cx="64" cy="62" r="47" fill="none" stroke="#00F5FF" stroke-width="2" opacity="0"/></g><g class="mk-motion"><g id="lens-${n}" opacity="1"><animate attributeName="opacity" values="1;1;0" keyTimes="0;.53;1" dur=".85s" fill="freeze"/><animateTransform attributeName="transform" type="rotate" from="-35 64 62" to="0 64 62" dur=".45s" fill="freeze"/><circle cx="64" cy="62" r="25" fill="none" stroke="#00F5FF" stroke-opacity=".07" stroke-width="10"/><circle cx="64" cy="62" r="23" fill="none" stroke="#00AEEF" stroke-width="4"/><path d="M64,45A17,17 0 0 1 81,62" fill="none" stroke="#00F5FF" stroke-width="3" stroke-linecap="round"/></g><path d="M64,15 L102,31 L102,65 C102,88 82,103 64,113 C46,103 26,88 26,65 L26,31 L64,15 Z" fill="#00AEEF" fill-opacity=".045" stroke="#00AEEF" stroke-width="5.5" stroke-linejoin="round" stroke-linecap="round" pathLength="1" stroke-dasharray="1" stroke-dashoffset="1" opacity="0"><animate attributeName="opacity" from="0" to="1" begin=".85s" dur=".1s" fill="freeze"/><animate attributeName="stroke-dashoffset" from="1" to="0" begin=".85s" dur=".5s" fill="freeze"/></path><defs><clipPath id="eye-clip-${n}"><path d="M32,62 C48,61.265 80,61.265 96,62 C80,62.665 48,62.665 32,62 Z"><animate attributeName="d" from="M32,62 C48,61.265 80,61.265 96,62 C80,62.665 48,62.665 32,62 Z" to="M32,62 C48,41 80,41 96,62 C80,81 48,81 32,62 Z" begin=".35s" dur=".5s" fill="freeze"/></path></clipPath></defs><g opacity="0"><animate attributeName="opacity" from="0" to="1" begin=".35s" dur=".3s" fill="freeze"/><path d="M32,62 C48,61.265 80,61.265 96,62 C80,62.665 48,62.665 32,62 Z" fill="#FFFFFF"><animate attributeName="d" from="M32,62 C48,61.265 80,61.265 96,62 C80,62.665 48,62.665 32,62 Z" to="M32,62 C48,41 80,41 96,62 C80,81 48,81 32,62 Z" begin=".35s" dur=".5s" fill="freeze"/></path><g clip-path="url(#eye-clip-${n})"><circle cx="64" cy="62" r="14" fill="#00AEEF"/><circle cx="64" cy="62" r="10" fill="#0A192F"/><path d="M61,57L69,62L61,67Z" fill="#00F5FF"/><circle cx="69" cy="56" r="1.5" fill="#FFFFFF" opacity=".85"/><g opacity="0"><animate attributeName="opacity" values="0;1;1;0" keyTimes="0;.1;.9;1" begin="1.35s" dur=".55s" fill="freeze"/><path d="M40,45V79" stroke="#00F5FF" stroke-width="2"><animateTransform attributeName="transform" type="translate" from="0 0" to="48 0" begin="1.35s" dur=".55s" fill="freeze"/></path></g></g></g><g opacity="0"><animate id="authenticated-${n}" attributeName="opacity" values="0;.42;0" keyTimes="0;.15;1" begin="indefinite" dur=".3s" fill="freeze"/><circle cx="64" cy="62" r="47" fill="none" stroke="#00F5FF" stroke-width="2"><animate attributeName="r" from="47" to="57.34" begin="authenticated-${n}.begin" dur=".3s" fill="freeze"/></circle></g></g></g></svg>`
}

/**
 * Plays every mark in root from the start every MARK_REPLAY_MS, while the page is in view; one that
 * comes back into view plays at once. Returns a stop function.
 */
/**
 * Plays every mark in root from the start, now. A mark drawn after the page has loaded (the sidebar is
 * drawn again when the account is known, or the page changes) does not always start its own clock at
 * nought: it could show the finished eye with nothing played (2026-10-16: "the animation is not always
 * working"). So whoever draws one plays it, on the next frame, once it is in the page.
 */
export function playMarks(root, { raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (f) => setTimeout(f, 0) } = {}) {
  raf(() => {
    for (const svg of root?.querySelectorAll?.('svg.mark-anim') ?? []) {
      if (!svg.isConnected) continue
      try {
        svg.setCurrentTime(0)
        svg.unpauseAnimations()
      } catch {} // (an SVG without SMIL: the mark stays as it is)
    }
  })
}

export function replayMarks(root, { every = MARK_REPLAY_MS, doc = document, setTimer = setInterval, clearTimer = clearInterval } = {}) {
  const play = () => {
    if (doc.hidden) return
    for (const svg of root.querySelectorAll('svg.mark-anim')) {
      try {
        svg.setCurrentTime(0)
        svg.unpauseAnimations()
      } catch {} // (an SVG without SMIL: the mark stays as it is)
    }
  }
  const timer = setTimer(play, every)
  const back = () => { if (!doc.hidden) play() }
  doc.addEventListener('visibilitychange', back)
  return () => {
    clearTimer(timer)
    doc.removeEventListener('visibilitychange', back)
  }
}
