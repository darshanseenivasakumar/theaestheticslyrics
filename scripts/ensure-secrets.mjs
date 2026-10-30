// Guarantees src/main/secrets.ts exists: CI and fresh clones copy the committed
// example when the git-ignored real file has not been created yet. Never overwrites
// a file the user pasted a key into (that is why copyFileSync is skipped while
// the target already exists).
import { copyFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const target = join(root, 'src', 'main', 'secrets.ts')
const example = join(root, 'src', 'main', 'secrets.example.ts')

if (!existsSync(target) && existsSync(example)) copyFileSync(example, target)
