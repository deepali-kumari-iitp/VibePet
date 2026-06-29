import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { SettingsRepository } from '../database/repositories/settingsRepository'

interface SeedManifest {
  settings?: Record<string, unknown>
}

/** Locate the bundled `seed/` folder across dev and packaged builds. */
function findSeedDir(): string | null {
  const candidates = [
    process.resourcesPath ? join(process.resourcesPath, 'seed') : '',
    join(app.getAppPath(), 'seed'),
    join(process.cwd(), 'seed')
  ].filter(Boolean)
  for (const dir of candidates) {
    if (existsSync(join(dir, 'seed.json'))) return dir
  }
  return null
}

/**
 * Seeds a fresh install with the sprites + config that ship in the app's
 * `seed/` folder, so users don't have to re-upload their animations on a new
 * machine. Everything is "fill in the blanks": existing files and settings are
 * never overwritten, so a user's own uploads always win.
 */
export function seedDefaults(settings: SettingsRepository): void {
  const seedDir = findSeedDir()
  if (!seedDir) return

  // 1. Copy bundled sprite files into the user's sprite directory if missing.
  const spriteSrc = join(seedDir, 'sprites')
  const spriteDest = join(app.getPath('userData'), 'sprites')
  if (existsSync(spriteSrc)) {
    if (!existsSync(spriteDest)) mkdirSync(spriteDest, { recursive: true })
    for (const file of readdirSync(spriteSrc)) {
      const dest = join(spriteDest, file)
      if (!existsSync(dest)) {
        try {
          copyFileSync(join(spriteSrc, file), dest)
        } catch {
          // best-effort; skip files we can't copy
        }
      }
    }
  }

  // 2. Seed settings (sprite config, game assets, model) only when absent.
  let manifest: SeedManifest
  try {
    manifest = JSON.parse(readFileSync(join(seedDir, 'seed.json'), 'utf8')) as SeedManifest
  } catch {
    return
  }

  for (const [key, value] of Object.entries(manifest.settings ?? {})) {
    if (settings.get(key) !== null) continue // user already has a value — keep it
    const stored = typeof value === 'string' ? value : JSON.stringify(value)
    settings.set(key, stored)
  }
}
