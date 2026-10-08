const PATH = require("path")
const FS = require("fs-extra")

const { normalizeRelative, normalizeTagName, tagKey } = require("./paths")

/**
 * Persistence for the tag index.
 *
 * The index is a plain JSON document inside the knowledge base, so it travels with the
 * repository and stays reviewable in git:
 *
 *   {
 *     "version": 1,
 *     "files": {
 *       "journal/2024-05-01.md": ["refactor", "架构"]
 *     }
 *   }
 *
 * Two properties matter more than raw speed here:
 *   - **Deterministic output.** Paths and tag arrays are sorted before serialising, so the
 *     same logical index always produces the same bytes and a tag edit touches one line.
 *   - **Never silently lose data.** A malformed file is reported as `corrupt` instead of
 *     being treated as an empty index; callers must refuse to write until the user decides.
 */

const INDEX_VERSION = 1
const DEFAULT_INDEX_FILE = ".kbdatabase/tags.json"
const STATUS = Object.freeze({ OK: "ok", MISSING: "missing", CORRUPT: "corrupt" })

const emptyIndex = () => ({ version: INDEX_VERSION, files: {} })

/**
 * `files` is a plain object, so a key of exactly `__proto__` would mutate the prototype
 * instead of adding an entry. Paths come from the index document, so reject it explicitly.
 */
const UNSAFE_KEY = "__proto__"

const compareNames = (a, b) => {
  const left = a.toLowerCase()
  const right = b.toLowerCase()
  if (left < right) return -1
  if (left > right) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

/** Canonical, diff-friendly serialisation: sorted paths, sorted tags, one path per line. */
const serializeIndex = index => {
  const source = (index && index.files) || {}
  const files = Object.create(null)

  Object.keys(source)
    .sort(compareNames)
    .forEach(filePath => {
      const tags = source[filePath]
      if (!Array.isArray(tags) || tags.length === 0) return
      const byKey = new Map()
      tags.forEach(tag => {
        const name = normalizeTagName(tag)
        if (!name) return
        const key = tagKey(name)
        if (!byKey.has(key)) byKey.set(key, name)
      })
      files[filePath] = [...byKey.values()].sort(compareNames)
    })

  return `${JSON.stringify({ version: INDEX_VERSION, files }, null, 2)}\n`
}

/**
 * Validate an arbitrary parsed value into a usable index.
 * Broken entries are dropped and reported rather than throwing, so one bad row cannot
 * make the whole knowledge base unreadable.
 */
const reviveIndex = parsed => {
  const issues = []
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { index: emptyIndex(), issues: ["index root is not an object"] }
  }
  if (parsed.files == null || typeof parsed.files !== "object" || Array.isArray(parsed.files)) {
    return { index: emptyIndex(), issues: ["index has no `files` object"] }
  }
  if (parsed.version != null && parsed.version !== INDEX_VERSION) {
    issues.push(`unexpected index version: ${JSON.stringify(parsed.version)}`)
  }

  const index = emptyIndex()
  Object.keys(parsed.files).forEach(rawPath => {
    if (rawPath === UNSAFE_KEY) {
      issues.push(`dropped unusable path: ${JSON.stringify(rawPath)}`)
      return
    }
    const filePath = normalizeRelative(rawPath)
    if (!filePath) {
      issues.push(`dropped unusable path: ${JSON.stringify(rawPath)}`)
      return
    }
    const rawTags = parsed.files[rawPath]
    if (!Array.isArray(rawTags)) {
      issues.push(`dropped non-array tags for: ${filePath}`)
      return
    }
    const byKey = new Map()
    rawTags.forEach(tag => {
      if (typeof tag !== "string") {
        issues.push(`dropped non-string tag for: ${filePath}`)
        return
      }
      const name = normalizeTagName(tag)
      if (!name) return
      const key = tagKey(name)
      if (!byKey.has(key)) byKey.set(key, name)
    })
    if (byKey.size) index.files[filePath] = [...byKey.values()]
  })

  return { index, issues }
}

class TagIndexStore {
  constructor({ repoDir, indexFile = DEFAULT_INDEX_FILE, fs = FS, path = PATH } = {}) {
    this.fs = fs
    this.path = path
    this.repoDir = repoDir || ""
    this.indexFile = indexFile || DEFAULT_INDEX_FILE
  }

  /** Absolute path of the index document. */
  get indexPath() {
    if (!this.repoDir) return ""
    if (this.path.isAbsolute(this.indexFile)) return this.indexFile
    return this.path.join(this.repoDir, this.indexFile)
  }

  async exists() {
    const target = this.indexPath
    if (!target) return false
    return this.fs.pathExists(target)
  }

  /**
   * Read the index.
   * @returns {Promise<{status: string, index: object, issues: string[], error?: Error}>}
   *   `status` is one of STATUS. A missing file is not an error — it simply means
   *   "no index yet". A corrupt file yields an empty index plus status CORRUPT, and the
   *   caller must not persist over it.
   */
  async load() {
    const target = this.indexPath
    if (!target) return { status: STATUS.MISSING, index: emptyIndex(), issues: ["no repository directory"] }

    let raw
    try {
      raw = await this.fs.readFile(target, "utf-8")
    } catch (err) {
      if (err && err.code === "ENOENT") return { status: STATUS.MISSING, index: emptyIndex(), issues: [] }
      throw err
    }

    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      return { status: STATUS.CORRUPT, index: emptyIndex(), issues: ["index is not valid JSON"], error: err }
    }

    const { index, issues } = reviveIndex(parsed)
    if (issues.length && !Object.keys(index.files).length) {
      return { status: STATUS.CORRUPT, index, issues }
    }
    return { status: STATUS.OK, index, issues }
  }

  /**
   * Write the index atomically: serialise to a sibling temp file, then move it over the
   * target. A crash therefore leaves either the old or the new document, never a torn one.
   */
  async save(index) {
    const target = this.indexPath
    if (!target) throw new Error("tagora: no repository directory to write the index into")

    await this.fs.ensureDir(this.path.dirname(target))
    const temporary = `${target}.tmp`
    await this.fs.writeFile(temporary, serializeIndex(index), "utf-8")
    await this.fs.move(temporary, target, { overwrite: true })
  }
}

module.exports = {
  INDEX_VERSION,
  DEFAULT_INDEX_FILE,
  STATUS,
  emptyIndex,
  serializeIndex,
  reviveIndex,
  compareNames,
  TagIndexStore,
}
