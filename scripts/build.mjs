// Packaging-only transpilation. Does not import the plugin or execute OpenCode.
import { stripTypeScriptTypes } from 'node:module'
import { mkdir, readdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
await mkdir(resolve(root, 'lib/types'), { recursive: true })
for (const file of await readdir(resolve(root, 'src'))) {
  if (!file.endsWith('.ts')) continue
  const source = await readFile(resolve(root, 'src', file), 'utf8')
  const output = stripTypeScriptTypes(source, { mode: 'strip' })
    .replace(/(from\s+['"]\.\.?\/[^'"]+)\.ts(['"])/g, '$1.js$2')
  await writeFile(resolve(root, 'lib', file.replace(/\.ts$/, '.js')), output, 'utf8')
}
await copyFile(resolve(root, 'types/index.d.ts'), resolve(root, 'lib/types/index.d.ts'))
process.stdout.write('Built JavaScript package files. No tests or CLI executions.\n')
