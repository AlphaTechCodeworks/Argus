// The Settings page controls for the box-wide live-stream cap (settings.html + settings.js):
// the on/off toggle, the stream limit, the HD headroom and the remote-warm-up option, under the
// Server tab. Wiring is checked against the source the way page-tabs.test.mjs checks its pages,
// since the page has no DOM to drive here. The cap's schema and its off==today behaviour are the
// server's to prove (settings.test.mjs, live-cap.test.mjs); this only guards the page's wiring.
//   node cctv/test/settings-livecap-ui.test.mjs
import { readFileSync } from 'node:fs'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
const pub = new URL('../public/', import.meta.url)
const html = readFileSync(new URL('settings.html', pub), 'utf8')
const js = readFileSync(new URL('settings.js', pub), 'utf8')

// ---- the page: the controls live under the Server tab, in the existing style --------------------
const main = /<main[^>]*>([\s\S]*)<\/main>/.exec(html)?.[1] ?? ''
const section = [...main.matchAll(/<section\b[^>]*>[\s\S]*?<\/section>/g)].map((m) => m[0]).find((s) => s.includes('id="liveCap"')) ?? ''
check('a section holds the cap form', Boolean(section))
check('it is a Server-tab section', /data-tab="server"/.test(section) && /class="se-section"/.test(section))
check('it is labelled for screen readers like the others', /aria-labelledby="cap-title"/.test(section) && /id="cap-title"/.test(section))
check('an on/off checkbox, labelled plainly', /<input id="lc-enabled" type="checkbox"/.test(section) && /Limit how many camera streams run at once/.test(section))
check('a help line says it protects the server when many screens/sites are open', /class="st-help"[^>]*>[^<]*overload/i.test(section) || /overload this server/i.test(section))
check('a number for the stream limit', /<input id="lc-max" type="number"/.test(section))
check('a number for the HD headroom', /<input id="lc-hd" type="number"/.test(section))
check('a checkbox for keeping remote (P2P) cameras warm', /<input id="lc-warm" type="checkbox"/.test(section) && /P2P/.test(section))
check('the limit/headroom/warm controls each sit in a row the script can hide', ['lc-max-row', 'lc-hd-row', 'lc-warm-row'].every((id) => section.includes(`id="${id}"`)))
check('a Save button and a message slot, in the page style', /<button type="submit" class="st-primary">Save<\/button>/.test(section) && /id="lc-msg"/.test(section))
// the Server tab already exists (settings-tabs.js), so no tab wiring is needed; just confirm it is there
check('the Server tab this section joins exists', /data-tab="server"/.test(main))

// ---- the script: reads the settings in, posts them back, gates on the toggle --------------------
check('renderLiveCap reads settings.liveCap', /function renderLiveCap\(\)/.test(js) && /settings\.liveCap/.test(js))
check('the toggle defaults ON (checked unless enabled is explicitly false)', /\$\('lc-enabled'\)\.checked = c\.enabled !== false/.test(js))
check('it fills the limit, headroom and warm-up controls', /\$\('lc-max'\)\.value = c\.maxStreams/.test(js) && /\$\('lc-hd'\)\.value = c\.hdHeadroom/.test(js) && /\$\('lc-warm'\)\.checked = c\.warmRemote === true/.test(js))
check('render() populates the cap form on load', /function render\(\)[\s\S]*renderLiveCap\(\)[\s\S]*\}/.test(js))

// the toggle hides the sub-controls when off, and is wired to the checkbox's change
// (inline display, since these are .se-grid labels the [hidden] attribute cannot hide: see settings.js)
check('showLiveCap hides the three rows when the cap is off', /function showLiveCap\(\)[\s\S]*lc-enabled[\s\S]*\]\)\s*\$\(id\)\.style\.display = on \? '' : 'none'/.test(js))
check('  it hides them with inline display, not the [hidden] attribute the grid CSS would override', !/showLiveCap[\s\S]*\$\(id\)\.hidden/.test(js))
check('  the three rows it hides are the limit, headroom and warm-up rows', /\['lc-max-row', 'lc-hd-row', 'lc-warm-row'\]/.test(js))
check('  and it runs when the toggle changes', /\$\('lc-enabled'\)\.addEventListener\('change', showLiveCap\)/.test(js))

// the submit posts a liveCap patch with the four fields to the shared settings route
const submit = /\$\('liveCap'\)\.addEventListener\('submit',[\s\S]*?\n\}\)/.exec(js)?.[0] ?? ''
check('submit posts to /api/admin/settings', /api\('POST', '\/api\/admin\/settings',/.test(submit))
check('  with a liveCap object', /liveCap:\s*\{/.test(submit))
check('  carrying enabled (bool), maxStreams, hdHeadroom and warmRemote', /enabled:\s*\$\('lc-enabled'\)\.checked/.test(submit) && /maxStreams:\s*Number\(\$\('lc-max'\)\.value\)/.test(submit) && /hdHeadroom:\s*Number\(\$\('lc-hd'\)\.value\)/.test(submit) && /warmRemote:\s*\$\('lc-warm'\)\.checked/.test(submit))
check('  it prevents the default form submit and reports the result', /e\.preventDefault\(\)/.test(submit) && /say\('lc-msg'/.test(submit))

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
