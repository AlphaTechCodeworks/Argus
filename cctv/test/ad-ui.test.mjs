// Windows (Active Directory) sign-in on the pages: Settings > Active Directory (settings.html,
// settings-tabs.js, ad-settings.js), the Users & access badge (audit.js), the sign-in page's
// "Change your Windows password" (login.html/.js), Change password for Windows accounts, and the
// server wiring (server.mjs), read from the files: none of it needs a browser or the SDK.
//   node cctv/test/ad-ui.test.mjs
import { readFileSync } from 'node:fs'

let failures = 0
const check = (n, ok, e = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${e ? `  (${e})` : ''}`) }
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const { trustText, statusText, testText, certLines } = await import('../public/ad-settings.js')

const settings = read('public/settings.html')
check('Settings has an Active Directory tab', /data-tab="directory"/.test(settings) && /\{ id: 'directory', label: 'Active Directory'/.test(read('public/settings-tabs.js')))
check('and loads its script', /<script type="module" src="ad-settings.js"><\/script>/.test(settings))
check('it says what it does in plain words, and that local accounts come first', /sign in with their Windows user name and password/.test(settings) && /Local Argus accounts keep working and always come first/.test(settings) && /keep one local admin/.test(settings))
check('the three groups and the switches are there', ['ad-enabled', 'ad-pwchange', 'ad-servers', 'ad-domain', 'ad-basedn', 'ad-g-admin', 'ad-g-viewer', 'ad-g-watch', 'ad-grace', 'ad-lookup-user', 'ad-lookup-pass', 'ad-recheck', 'ad-ca', 'ad-test-user', 'ad-test-pass'].every((id) => settings.includes(`id="${id}"`)))
check('the password-change switch has the owner\'s words', /Let AD users change their Windows password in Argus/.test(settings))
check('the look-up password field never shows the saved one', /id="ad-lookup-pass" type="password" autocomplete="new-password"/.test(settings))
check('Check connection / Trust this certificate are offered', /Check connection/.test(read('public/ad-settings.js')) && /Trust this certificate/.test(read('public/ad-settings.js')))

check('trust words', trustText('pinned') === 'Trusted (certificate pinned)' && /Not trusted yet/.test(trustText('none')))
const s = { enabled: true, domain: 'JFL.LOCAL', servers: ['192.168.0.19', '192.168.1.19'], trust: { '192.168.0.19': 'pinned', '192.168.1.19': 'none' }, lookupUser: '', graceHours: 8 }
check('status line: on, untrusted DCs named, no look-up account explained', /^On: staff can sign in with their JFL.LOCAL Windows account\. Not trusted yet: 192\.168\.1\.19\. No look-up account: Windows users sign in again every 8 hours\.$/.test(statusText(s)))
check('status line: off', /^Off: only local Argus accounts can sign in\./.test(statusText({ ...s, enabled: false, trust: {} })))
check('test result words, with groups not found named', testText({ message: 'bob would sign in as Viewer.', groups: { admin: { name: 'CCTV Admins', dn: null }, viewer: { name: 'CCTV Viewers', dn: 'CN=x' } }, lookup: { message: 'The look-up account can re-check bob (Viewer).' } }) === 'bob would sign in as Viewer. The group "CCTV Admins" was not found in AD. The look-up account can re-check bob (Viewer).')
const lines = certLines({ subject: 'CN=DC01.JFL.LOCAL', issuer: 'DC=LOCAL, DC=JFL, CN=DC01', altNames: '', validFrom: 'a', validTo: 'b', expired: true, fingerprint256: 'AA' })
check('the certificate is shown as subject, issuer, validity (EXPIRED said) and SHA-256', lines.map((l) => l[0]).join() === 'Issued to,Issued by,Valid,SHA-256 fingerprint' && /EXPIRED/.test(lines[2][1]))

const auditJs = read('public/audit.js')
check('Users & access: AD users get an "Active Directory" badge, their role "from their AD group"', /textContent: 'Active Directory'/.test(auditJs) && /from their AD group/.test(auditJs))
check('Users & access: no Reset password for an AD user (Edit access, set-up code and Sign out user stay)', /act\.append\(edit, setup, \.\.\.\(fromAd \? \[\] : \[reset\]\), kick, rm\)/.test(auditJs))

const login = read('public/login.html')
const loginJs = read('public/login.js')
check('sign-in page: a "Change your Windows password" form, hidden until AD asks for it', /<form id="winPassword" class="login-card" autocomplete="off" hidden>/.test(login) && /Change your Windows password/.test(login) && /if \(body\.canChangePassword\)/.test(loginJs))
check('it asks for the current password and the new one twice', ['winCurrent', 'winNew', 'winConfirm'].every((id) => login.includes(`id="${id}"`)) && /The new passwords are not the same/.test(loginJs))
check('and posts to the Windows password route', /\/api\/login\/windows-password/.test(loginJs))
const cpJs = read('public/change-password.js')
check('Change password: a Windows account sees "Change your Windows password" and the success words', /me\?\.windows/.test(cpJs) && /Change your Windows password/.test(cpJs) && /result\.message/.test(cpJs))
check('the sidebar links a Windows account to it', /me\.windows \? '<a class="btn-ghost btn-icon" href="\/change-password\.html"/.test(read('public/shell.js')))

const server = read('server.mjs')
check('server: the login asks AD only through ad.login (local first inside it)', /const viaAd = await ad\.login\(String\(creds\.user \?\? ''\), creds\.password \?\? '', \{ ip \}\)/.test(server))
check('server: AD refusals count with the same rate limit', /if \(viaAd\.count\) auth\.recordFailure\(ip\)/.test(server))
check('server: the Windows password route is rate-limited too', /handleWindowsPassword[\s\S]{0,200}auth\.loginBlocked\(ip\)/.test(server))
check('server: renames move rights, views, preferences, set-up codes and bookmarks', /renamers: \[renameRights, renameUserViews, renameUserPrefs, \(from, to\) => setupCodes\.rename\(from, to\), renameBookmarkUser\]/.test(server))
check('server: the admin routes are wired', /const adRoute = await handleAd\(ad, req\.method, pathname/.test(server))
check('server: /api/me says when the account is a Windows one', /windows: true/.test(server))

const ad = read('ad.mjs')
check('the owner\'s words: must change, changed', /Your Windows password must be changed\. Change it on a Windows PC, then sign in again\./.test(ad) && /Your Windows password has been changed\. Use the new one on your PC too\./.test(ad))
check('the policy refusal in plain words', /does not meet the domain’s password rules — length, complexity or history/.test(ad))

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exitCode = failures ? 1 : 0
