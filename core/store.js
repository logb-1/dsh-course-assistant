/**
 * Local store: uploads, jobs, reports and a small TTL cache.
 *
 * Everything stays on this machine: no account data, no database. The default
 * root is `<DSH_HOME>/course-assistant` (override with the plugin config's
 * `dataDir`), so a workspace stays clean.
 */
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join, extname } from 'node:path'
import { homedir } from 'node:os'

export function resolveDataDir(configured) {
  if (configured) return configured
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'course-assistant')
}

function ensure(dir) {
  mkdirSync(dir, { recursive: true })
  return dir
}

function atomicWrite(path, text) {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, path)
}

export function createStore(dataDir) {
  const uploadsDir = ensure(join(dataDir, 'uploads'))
  const reportsDir = ensure(join(dataDir, 'reports'))
  const jobsDir = ensure(join(dataDir, 'jobs'))
  const ocrDir = ensure(join(dataDir, 'ocr'))
  const cachePath = join(dataDir, 'cache.json')
  const uploadsIndexPath = join(uploadsDir, 'index.json')

  /** uploadId → { name, path, sha256, bytes, createdAt, lastUsedAt } */
  let uploadsIndex = null
  const loadIndex = () => {
    if (uploadsIndex) return uploadsIndex
    try {
      uploadsIndex = JSON.parse(readFileSync(uploadsIndexPath, 'utf8')) || {}
    } catch {
      uploadsIndex = {}
    }
    return uploadsIndex
  }
  const saveIndex = () => {
    try {
      atomicWrite(uploadsIndexPath, JSON.stringify(uploadsIndex || {}))
    } catch {}
  }

  let cacheData = null
  const loadCache = () => {
    if (cacheData) return cacheData
    try {
      cacheData = JSON.parse(readFileSync(cachePath, 'utf8'))
    } catch {
      cacheData = {}
    }
    return cacheData
  }
  let saveTimer = null
  const scheduleSave = () => {
    if (saveTimer) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      try {
        atomicWrite(cachePath, JSON.stringify(cacheData || {}))
      } catch {}
    }, 500)
    saveTimer.unref?.()
  }

  return {
    dataDir,
    uploadsDir,
    reportsDir,
    jobsDir,
    ocrDir,

    cache: {
      async get(key) {
        const entry = loadCache()[key]
        if (!entry) return null
        if (entry.exp && entry.exp < Date.now()) {
          delete loadCache()[key]
          scheduleSave()
          return null
        }
        return entry.value
      },
      async set(key, value, ttlMs) {
        loadCache()[key] = { value, exp: ttlMs ? Date.now() + ttlMs : 0 }
        scheduleSave()
      },
      flush() {
        if (cacheData) {
          try {
            atomicWrite(cachePath, JSON.stringify(cacheData))
          } catch {}
        }
      },
      /** Drop expired entries and cap the file so it cannot grow forever. */
      prune(maxEntries = 500) {
        const data = loadCache()
        const now = Date.now()
        let changed = false
        for (const [key, entry] of Object.entries(data)) {
          if (entry?.exp && entry.exp < now) {
            delete data[key]
            changed = true
          }
        }
        const keys = Object.keys(data)
        if (keys.length > maxEntries) {
          // soonest-expiring first; entries without an expiry sort last (kept)
          const ordered = keys.sort(
            (a, b) => (data[a]?.exp || Number.MAX_SAFE_INTEGER) - (data[b]?.exp || Number.MAX_SAFE_INTEGER),
          )
          for (const key of ordered.slice(0, keys.length - maxEntries)) delete data[key]
          changed = true
        }
        if (changed) {
          try {
            atomicWrite(cachePath, JSON.stringify(data))
          } catch {}
        }
        return changed
      },
    },

    saveUpload(buf, fileName) {
      const safeName = String(fileName || 'file').replace(/[\\/:*?"<>|]/g, '_').slice(-120)
      const hash = createHash('sha256').update(buf).digest('hex').slice(0, 16)
      const id = `${Date.now().toString(36)}-${hash}`
      const path = join(uploadsDir, `${id}${extname(safeName).toLowerCase()}`)
      writeFileSync(path, buf)
      const record = { id, name: safeName, path, bytes: buf.length, sha256: hash, createdAt: Date.now(), lastUsedAt: Date.now() }
      loadIndex()[id] = record
      saveIndex()
      return record
    },

    /** Look up an upload after a restart (the in-memory map is gone). */
    findUpload(id) {
      const record = loadIndex()[id]
      if (!record) return null
      if (!existsSync(record.path)) return { ...record, missing: true }
      return record
    },

    /** Mark uploads as still in use so pruning cannot delete a live job's input. */
    touchUploads(ids = []) {
      const index = loadIndex()
      let changed = false
      for (const id of ids) {
        if (index[id]) {
          index[id].lastUsedAt = Date.now()
          changed = true
        }
      }
      if (changed) saveIndex()
    },

    readOcr(file) {
      try {
        const data = JSON.parse(readFileSync(join(ocrDir, file), 'utf8'))
        return data?.pages?.length ? data.pages : null
      } catch {
        return null
      }
    },
    writeOcr(file, payload) {
      try {
        atomicWrite(join(ocrDir, file), JSON.stringify(payload))
        return true
      } catch {
        return false
      }
    },

    saveJob(job) {
      try {
        atomicWrite(join(jobsDir, `${job.id}.json`), JSON.stringify(job))
      } catch {}
    },

    loadJob(id) {
      try {
        return JSON.parse(readFileSync(join(jobsDir, `${id}.json`), 'utf8'))
      } catch {
        return null
      }
    },

    listJobs(limit = 20) {
      try {
        return readdirSync(jobsDir)
          .filter((n) => n.endsWith('.json'))
          .map((n) => {
            const p = join(jobsDir, n)
            return { id: n.replace(/\.json$/, ''), mtime: statSync(p).mtimeMs }
          })
          .sort((a, b) => b.mtime - a.mtime)
          .slice(0, limit)
      } catch {
        return []
      }
    },

    writeReport(baseName, markdown) {
      const safe = String(baseName || 'report').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)
      const stem = `${safe}-${new Date().toISOString().slice(0, 10)}`
      let path = join(reportsDir, `${stem}.md`)
      let n = 1
      while (existsSync(path)) path = join(reportsDir, `${stem}-${n++}.md`)
      writeFileSync(path, markdown, 'utf8')
      return path
    },

    writeBytes(path, bytes) {
      writeFileSync(path, bytes)
      return path
    },

    /** Drop uploads older than N days, honouring "still referenced by a job". */
    pruneUploads(days = 7) {
      const cutoff = Date.now() - days * 86400000
      const index = loadIndex()
      const keep = new Set()
      try {
        for (const [id, record] of Object.entries(index)) {
          const stamp = Math.max(record.lastUsedAt || 0, record.createdAt || 0)
          if (stamp < cutoff) {
            rmSync(record.path, { force: true })
            delete index[id]
          } else {
            keep.add(record.path)
          }
        }
        // files written before the index existed: fall back to mtime
        for (const name of readdirSync(uploadsDir)) {
          if (name === 'index.json') continue
          const p = join(uploadsDir, name)
          if (statSync(p).mtimeMs < cutoff && !keep.has(p)) rmSync(p, { force: true })
        }
        saveIndex()
      } catch {}
    },
  }
}

export const newJobId = () => randomUUID().slice(0, 8)
