import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, dialog, net, protocol, session } from 'electron'
import { IPC } from '@shared/ipc-contract'
import { getRepositories, closeDatabase } from './database'
import { createPlatformServices, type PlatformServices } from './platform'
import { registerIpc } from './ipc/registerIpc'
import { AIService } from './services/aiService'
import { ClipboardService } from './services/clipboardService'
import { DuckMotionService } from './services/duckMotionService'
import { GameAssetService } from './services/gameAssetService'
import { GameService } from './services/gameService'
import { PromptBoostService } from './services/promptBoostService'
import { PromptWatchService } from './services/promptWatchService'
import { seedDefaults } from './services/seedService'
import { SpriteService } from './services/spriteService'
import { SupabaseService } from './services/supabaseService'
import { VisibilityService } from './services/visibilityService'
import { createTray } from './windows/tray'
import { WindowManager } from './windows/windowManager'
import type { Tray } from 'electron'

const PANEL_SHORTCUT = 'CommandOrControl+Shift+D'
const SIT_SHORTCUT = 'CommandOrControl+Shift+0'
const isDev = !!process.env['ELECTRON_RENDERER_URL']

// A custom scheme to serve user sprite sheets. Needed because the renderer runs
// over http:// in dev, which forbids loading file:// images. Must be registered
// as privileged before the app is ready.
const SPRITE_SCHEME = 'sprite'
protocol.registerSchemesAsPrivileged([
  {
    scheme: SPRITE_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true, corsEnabled: true }
  }
])

function registerSpriteProtocol(): void {
  const dir = join(app.getPath('userData'), 'sprites')
  protocol.handle(SPRITE_SCHEME, (request) => {
    const { pathname } = new URL(request.url)
    const file = basename(decodeURIComponent(pathname))
    return net.fetch(pathToFileURL(join(dir, file)).toString())
  })
}

let platform: PlatformServices | null = null
let clipboardService: ClipboardService | null = null
let visibilityService: VisibilityService | null = null
let motionService: DuckMotionService | null = null
let promptWatchService: PromptWatchService | null = null
let tray: Tray | null = null

function applyProdCsp(): void {
  if (isDev) return
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        // NOTE: pages load over file:// in production, where `'self'` does NOT
        // match local subresources — so we must allow `file:` explicitly or the
        // bundled JS/CSS get blocked and every window renders blank.
        'Content-Security-Policy': [
          "default-src 'self' file: data: blob:; script-src 'self' file: 'unsafe-inline'; style-src 'self' file: 'unsafe-inline'; img-src 'self' file: data: blob: sprite:; font-src 'self' file: data:; connect-src 'self' https://openrouter.ai https://*.supabase.co wss://*.supabase.co"
        ]
      }
    })
  })
}

function bootstrap(): void {
  try {
    applyProdCsp()
    registerSpriteProtocol()

    const repos = getRepositories()

    // Pre-fill bundled sprites/animations/config on first run so a fresh install
    // (on any machine) doesn't require re-uploading. Never overwrites user data.
    seedDefaults(repos.settings)

    platform = createPlatformServices({
      read: (key) => repos.settings.get(key),
      write: (key, value) => repos.settings.set(key, value),
      remove: (key) => repos.settings.remove(key)
    })

    const ai = new AIService(repos.settings, platform.secureStorage)
    const sprites = new SpriteService(repos.settings)
    const windows = new WindowManager()

    const auth = new SupabaseService(platform.secureStorage)
    auth.onStateChange((state) => windows.broadcast(IPC.EvtAuthState, state))
    void auth.restore()

    visibilityService = new VisibilityService(platform.activeApp, repos.settings, (visible) =>
      windows.setDuckVisible(visible)
    )

    clipboardService = new ClipboardService(platform.clipboard, repos.clipboard)

    // The duck roams the screen on its own, facing the cursor's direction.
    motionService = new DuckMotionService(windows)

    // Mini-games: pause the duck's autopilot while a game owns the screen.
    const games = new GameService(windows, motionService, visibilityService)
    const gameAssets = new GameAssetService(repos.settings)

    // Prompt Boost: rewrite the user's prompt before it's sent (⌘/Ctrl+Enter).
    const promptBoost = new PromptBoostService(
      repos.settings,
      platform.activeApp,
      ai,
      windows,
      platform.shortcuts
    )
    promptBoost.init()

    registerIpc({
      repos,
      ai,
      windows,
      sprites,
      visibility: visibilityService,
      auth,
      clipboard: clipboardService,
      motion: motionService,
      promptBoost,
      games,
      gameAssets
    })

    windows.createDuckWindow()

    clipboardService.start((item) => {
      windows.broadcast(IPC.EvtClipboardCaptured, item)
      windows.broadcast(IPC.EvtDuckBehavior, { behavior: 'celebrating' })
      // Mirror to the cloud when signed in (offline-safe, fire-and-forget).
      void auth.pushClipboard(item)
    })

    platform.shortcuts.register(PANEL_SHORTCUT, () => windows.togglePanel())

    // Start app-aware visibility after the window exists so it can show/hide it.
    visibilityService.start()

    motionService.start()

    // Peek at the user's prompt when they're typing into an AI chat box.
    promptWatchService = new PromptWatchService(
      platform.activeApp,
      motionService,
      windows,
      () => visibilityService!.getConfig(),
      promptBoost
    )
    promptWatchService.start()

    // Always-present menu-bar/tray icon so the app is reachable even when the
    // duck is hidden (it only appears on coding/AI apps).
    tray = createTray({ windows, promptBoost, visibility: visibilityService })

    // Let the user know it launched (the duck stays hidden until they're in an
    // editor/AI app, which can otherwise look like "nothing happened").
    platform.notifications.notify(
      'VibeDuck is running 🦆',
      "I'll pop up when you're in your editor or an AI chat. Find me in the menu bar."
    )

    // Sit/stay toggle: freeze the duck in place (and tell the user).
    platform.shortcuts.register(SIT_SHORTCUT, () => {
      const sitting = motionService?.toggleSit() ?? false
      windows.broadcast(IPC.EvtDuckBehavior, { behavior: sitting ? 'sitting' : 'happy' })
      windows.broadcast(IPC.EvtDuckSay, {
        text: sitting ? 'Staying right here! 🪑' : 'Following you again! 🦆',
        tone: 'info'
      })
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) windows.createDuckWindow()
    })
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error)
    console.error('[VibeDuck] Failed to start:', message)
    dialog.showErrorBox('VibeDuck failed to start', message)
  }
}

app.whenReady().then(bootstrap)

// Overlay model: closing windows does not quit the app.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // The duck persists on Windows; explicit quit (tray) comes later.
  }
})

app.on('will-quit', () => {
  clipboardService?.dispose()
  visibilityService?.stop()
  motionService?.stop()
  promptWatchService?.stop()
  platform?.shortcuts.unregisterAll()
  tray?.destroy()
  closeDatabase()
})
