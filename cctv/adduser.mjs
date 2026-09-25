// Manage viewer accounts.
//   node cctv/adduser.mjs <name> [--admin]   add a user or change their password (prompts)
//                                             --admin: may manage NVRs and sites in the app
//   node cctv/adduser.mjs <name> --viewer    make an existing user a viewer (keeps the password)
//   node cctv/adduser.mjs --remove <name>    remove a user
//   node cctv/adduser.mjs --list             list users and roles
import { hashPassword, loadUsers, saveUsers } from './auth.mjs'
import { askHidden } from './prompt.mjs'

const args = process.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith('--')))
const [name] = args.filter((a) => !a.startsWith('--'))
const users = loadUsers()

if (flags.has('--list')) {
  const list = Object.entries(users).map(([n, u]) => `${n.padEnd(20)} ${u.role}`)
  console.log(list.join('\n') || '(no users)')
  process.exit(0)
}

if (flags.has('--remove')) {
  if (!name || !(name in users)) {
    console.error(`No such user: ${name ?? ''}`)
    process.exit(1)
  }
  delete users[name]
  saveUsers(users)
  console.log(`Removed ${name}`)
  process.exit(0)
}

if (!name || !/^[\w.@-]{1,64}$/.test(name)) {
  console.error('Usage: node cctv/adduser.mjs <name> [--admin]   (letters, digits, . _ @ -)')
  process.exit(1)
}

// role change only, for an existing user
if ((flags.has('--admin') || flags.has('--viewer')) && name in users && !flags.has('--password')) {
  const wanted = flags.has('--admin') ? 'admin' : 'viewer'
  const label = wanted === 'admin' ? 'an admin' : 'a viewer'
  if (users[name].role === wanted) {
    console.log(`${name} is already ${label} (add --password to change the password)`)
    process.exit(0)
  }
  users[name].role = wanted
  saveUsers(users)
  console.log(`${name} is now ${label}`)
  process.exit(0)
}

const password = process.env.CCTV_NEW_PASSWORD ?? (await askHidden('Password: '))
if (password.length < 8) {
  console.error('Password must be at least 8 characters')
  process.exit(1)
}
if (!process.env.CCTV_NEW_PASSWORD && (await askHidden('Repeat password: ')) !== password) {
  console.error('Passwords do not match')
  process.exit(1)
}

const existed = name in users
const role = flags.has('--admin') ? 'admin' : flags.has('--viewer') ? 'viewer' : (users[name]?.role ?? 'viewer')
users[name] = { hash: await hashPassword(password), role }
saveUsers(users)
console.log(`${existed ? 'Updated' : 'Added'} ${name} (${role})`)
process.exit(0)
