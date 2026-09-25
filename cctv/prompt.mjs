// Terminal prompts for the command-line tools. Input lines are queued, so answers
// typed ahead (or piped in) are not lost between questions.
import { createInterface } from 'node:readline'

let rl = null
let muted = false
const lines = []
const waiting = []

const reader = () => {
  if (!rl) {
    rl = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) })
    rl._writeToOutput = (s) => {
      if (!muted) rl.output.write(s)
    }
    rl.on('line', (line) => {
      const next = waiting.shift()
      if (next) next(line)
      else lines.push(line)
    })
    rl.on('close', () => {
      for (const next of waiting.splice(0)) next('')
    })
  }
  return rl
}

const nextLine = () =>
  new Promise((resolve) => {
    reader()
    if (lines.length) resolve(lines.shift())
    else waiting.push(resolve)
  })

/** Asks a question; returns the answer, or `fallback` if left empty. */
export const ask = async (question, fallback = '') => {
  const hint = fallback ? ` [${fallback}]` : ''
  process.stdout.write(`${question}${hint}: `)
  const answer = (await nextLine()).trim()
  if (!process.stdin.isTTY) process.stdout.write('\n')
  return answer || fallback
}

/** Reads a line without echoing it (passwords). */
export const askHidden = async (question) => {
  process.stdout.write(question)
  muted = true
  const answer = await nextLine()
  muted = false
  process.stdout.write('\n')
  return answer
}
