/**
 * Filesystem watcher for app hot-reload.
 *
 * Watches configured app directories for changes. Debounces rapid
 * file-system events and detects app add/change/remove.
 * Uses Node built-in fs.watch (no external dependencies).
 */

import { watch, readdirSync, statSync, existsSync, type FSWatcher } from 'fs'
import { join, resolve, basename } from 'path'
import { findEntryFile } from './app-loader.js'

export interface FileWatcherCallbacks {
  onAppChanged: (appDir: string) => void
  onAppAdded: (appDir: string) => void
  onAppRemoved: (appDir: string) => void
}

export class AppFileWatcher {
  private watchers = new Map<string, FSWatcher>()
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private knownApps = new Map<string, Set<string>>() // absDir → set of app subdirectory names

  constructor(
    private appDirs: string[],
    private serverDir: string,
    private callbacks: FileWatcherCallbacks,
    private debounceMs: number = 300,
  ) {}

  start(): void {
    for (const dir of this.appDirs) {
      const absDir = resolve(this.serverDir, dir)
      if (!existsSync(absDir)) continue

      // Snapshot current app subdirectories
      this.knownApps.set(absDir, this.scanAppNames(absDir))

      try {
        this.startWatcher(absDir)
      } catch {
        // recursive watch not supported — fall back to per-directory watchers
        this.startPerDirWatchers(absDir)
      }
    }
  }

  stop(): void {
    for (const watcher of this.watchers.values()) {
      watcher.close()
    }
    this.watchers.clear()
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer)
    }
    this.debounceTimers.clear()
  }

  private startWatcher(absDir: string): void {
    const watcher = watch(absDir, { recursive: true }, (_event, filename) => {
      if (!filename) return
      // Extract the top-level app subdirectory name from the changed path
      const parts = filename.replace(/\\/g, '/').split('/')
      const appName = parts[0]
      if (!appName) return
      this.handleChange(absDir, appName)
    })

    watcher.on('error', (err) => {
      console.error(`[file-watcher] Error watching ${absDir}:`, err.message)
    })

    this.watchers.set(absDir, watcher)
  }

  /** Fallback for platforms where recursive watch is not supported. */
  private startPerDirWatchers(absDir: string): void {
    const known = this.knownApps.get(absDir) ?? new Set()
    for (const appName of known) {
      const appDir = join(absDir, appName)
      try {
        const watcher = watch(appDir, { recursive: false }, (_event, _filename) => {
          this.handleChange(absDir, appName)
        })
        watcher.on('error', () => {})
        this.watchers.set(appDir, watcher)
      } catch {
        // ignore individual failures
      }
    }

    // Also watch the parent to detect new/removed app dirs
    try {
      const parentWatcher = watch(absDir, { recursive: false }, () => {
        this.checkAddRemove(absDir)
      })
      parentWatcher.on('error', () => {})
      this.watchers.set(`${absDir}:parent`, parentWatcher)
    } catch {
      // ignore
    }
  }

  private handleChange(absDir: string, appName: string): void {
    const key = `${absDir}/${appName}`

    // Debounce: clear any pending timer and start a new one
    const existing = this.debounceTimers.get(key)
    if (existing) clearTimeout(existing)

    this.debounceTimers.set(
      key,
      setTimeout(() => {
        this.debounceTimers.delete(key)
        this.checkAddRemove(absDir)

        const appDir = join(absDir, appName)
        if (existsSync(appDir) && findEntryFile(appDir)) {
          const known = this.knownApps.get(absDir)
          if (known?.has(appName)) {
            this.callbacks.onAppChanged(appDir)
          }
          // onAppAdded is handled by checkAddRemove
        }
      }, this.debounceMs),
    )
  }

  private checkAddRemove(absDir: string): void {
    const prev = this.knownApps.get(absDir) ?? new Set()
    const current = this.scanAppNames(absDir)
    this.knownApps.set(absDir, current)

    // Detect additions
    for (const name of current) {
      if (!prev.has(name)) {
        this.callbacks.onAppAdded(join(absDir, name))
      }
    }

    // Detect removals
    for (const name of prev) {
      if (!current.has(name)) {
        this.callbacks.onAppRemoved(join(absDir, name))
      }
    }
  }

  /** Scan a directory for subdirectories that contain an index.ts/js entry. */
  private scanAppNames(absDir: string): Set<string> {
    const names = new Set<string>()
    let children: string[]
    try {
      children = readdirSync(absDir)
    } catch {
      return names
    }
    for (const child of children) {
      const childPath = join(absDir, child)
      try {
        if (!statSync(childPath).isDirectory()) continue
      } catch {
        continue
      }
      if (findEntryFile(childPath)) {
        names.add(child)
      }
    }
    return names
  }
}

/**
 * Resolve an app directory path to its app name (directory basename).
 * Used by main.ts to map file-watcher events back to app IDs.
 */
export function appDirToName(appDir: string): string {
  return basename(appDir)
}
