const {
  MAX_TAG_LENGTH,
  normalizeRelative,
  normalizeTagName,
  tagKey,
} = require("./paths")
const { STATUS, emptyIndex } = require("./store")

/**
 * Tag domain logic — the JavaScript port of KBManager's `KnowledgeBaseService`.
 *
 * Modelled as `filePath -> tags` (case-insensitive identity, original spelling preserved).
 * There is deliberately no shared tag table: because tags live on the file row, dropping a
 * file row can never orphan another file's tags, which removes the whole class of
 * orphan-garbage-collection bookkeeping the EF version needed.
 *
 * Untagged files are not persisted. The file tree is driven by the real directory
 * (Typora's own sidebar), so the index only ever has to answer "which tags does this file
 * have" and "which files carry this tag" — an empty row answers nothing.
 *
 * Every mutation is written through immediately, and a failed write is rolled back so the
 * in-memory index never claims something the file on disk does not contain.
 */

const REASON = Object.freeze({
  OK: "ok",
  DUPLICATE: "duplicate",
  NOT_FOUND: "not-found",
  EMPTY_TAG: "empty-tag",
  TAG_TOO_LONG: "tag-too-long",
  TAG_INVALID: "tag-invalid",
  PATH_INVALID: "path-invalid",
  CORRUPT_INDEX: "corrupt-index",
  NO_REPOSITORY: "no-repository",
  WRITE_FAILED: "write-failed",
})

const fail = (reason, extra) => ({ success: false, changed: false, reason, ...extra })
const done = (reason = REASON.OK, extra) => ({ success: true, changed: true, reason, ...extra })

class TagRepository {
  constructor({ store, now = () => Date.now() } = {}) {
    this.store = store
    this.now = now
    this.files = new Map() // filePath -> Map<tagKey, displayName>
    this.status = STATUS.MISSING
    this.issues = []
    this.loadedAt = 0
  }

  get readOnly() {
    return this.status === STATUS.CORRUPT
  }

  /** True when the index is usable but has never been written. */
  get isNew() {
    return this.status === STATUS.MISSING
  }

  // ---- loading / serialising ------------------------------------------------

  async load() {
    const result = await this.store.load()
    this.status = result.status
    this.issues = result.issues || []
    this.files = TagRepository._toMap(result.index)
    this.loadedAt = this.now()
    return result
  }

  toJSON() {
    const files = {}
    this.files.forEach((tags, filePath) => {
      // Assigning `__proto__` would rewrite the prototype instead of adding an entry.
      if (filePath === "__proto__") return
      const names = [...tags.values()]
      if (names.length) files[filePath] = names
    })
    return { version: emptyIndex().version, files }
  }

  static _toMap(index) {
    const files = new Map()
    const source = (index && index.files) || {}
    Object.keys(source).forEach(filePath => {
      const tags = new Map()
      const list = Array.isArray(source[filePath]) ? source[filePath] : []
      list.forEach(tag => {
        const name = normalizeTagName(tag)
        if (name) tags.set(tagKey(name), name)
      })
      if (tags.size) files.set(filePath, tags)
    })
    return files
  }

  // ---- queries --------------------------------------------------------------

  get filePaths() {
    return [...this.files.keys()].sort(TagRepository._compare)
  }

  get fileCount() {
    return this.files.size
  }

  /** Distinct tag names, case-insensitive. */
  get tagNames() {
    return this.tagsWithCounts().map(entry => entry.tagName)
  }

  get tagCount() {
    return this._groupByTag().size
  }

  hasFile(filePath) {
    const path = normalizeRelative(filePath)
    return !!path && this.files.has(path)
  }

  getFileTags(filePath) {
    const path = normalizeRelative(filePath)
    if (!path) return []
    const tags = this.files.get(path)
    if (!tags) return []
    return [...tags.values()].sort(TagRepository._compare)
  }

  /** Every tagged file with its complete tag set, ordered by path. */
  listFiles() {
    return this.filePaths.map(filePath => ({ filePath, tags: this.getFileTags(filePath) }))
  }

  /** Tag usage counts: most used first, then by name. */
  tagsWithCounts() {
    return [...this._groupByTag().entries()]
      .map(([, entry]) => ({ tagName: entry.display, fileCount: entry.count }))
      .sort((a, b) => (b.fileCount - a.fileCount) || TagRepository._compare(a.tagName, b.tagName))
  }

  /** Exact tag match (case-insensitive); each hit carries the file's full tag set. */
  searchByTag(tagName) {
    const key = tagKey(tagName)
    if (!key) return []
    return this.filePaths
      .filter(filePath => this.files.get(filePath).has(key))
      .map(filePath => ({ filePath, tags: this.getFileTags(filePath) }))
  }

  /**
   * Autocomplete candidates.
   * Excludes tags the file already carries, matches case-insensitively on substring,
   * orders by usage then name, and caps the result.
   */
  suggestTags(query, { exclude = [], limit = 10 } = {}) {
    const needle = tagKey(query)
    const excluded = new Set((exclude || []).map(tagKey).filter(Boolean))
    return this.tagsWithCounts()
      .filter(entry => {
        const key = tagKey(entry.tagName)
        if (excluded.has(key)) return false
        return needle ? key.includes(needle) : true
      })
      .slice(0, limit)
  }

  /**
   * The exact spelling already in use for this tag, if any.
   * Adding `Git` when `git` exists therefore reuses `git` instead of splitting the tag in two.
   */
  canonicalTagName(tagName) {
    const key = tagKey(tagName)
    if (!key) return ""
    const entry = this._groupByTag().get(key)
    return entry ? entry.display : normalizeTagName(tagName)
  }

  /** Indexed records whose file is gone from disk (case-insensitive comparison). */
  findStale(pathsOnDisk) {
    const onDisk = new Set((pathsOnDisk || []).map(normalizeRelative).filter(Boolean).map(p => p.toLowerCase()))
    return this.filePaths.filter(filePath => !onDisk.has(filePath.toLowerCase()))
  }

  // ---- mutations ------------------------------------------------------------

  async addTag(filePath, tagName) {
    const path = normalizeRelative(filePath)
    if (!path) return fail(REASON.PATH_INVALID)

    const checked = TagRepository._validateTag(tagName)
    if (!checked.ok) return fail(checked.reason)

    return this._mutate(() => {
      const tags = this.files.get(path) || new Map()
      const name = this.canonicalTagName(checked.name)
      const key = tagKey(name)
      if (tags.has(key)) return fail(REASON.DUPLICATE, { tagName: name })
      tags.set(key, name)
      this.files.set(path, tags)
      return done(REASON.OK, { tagName: name })
    })
  }

  async removeTag(filePath, tagName) {
    const path = normalizeRelative(filePath)
    if (!path) return fail(REASON.PATH_INVALID)

    const key = tagKey(tagName)
    if (!key) return fail(REASON.EMPTY_TAG)

    return this._mutate(() => {
      const tags = this.files.get(path)
      if (!tags || !tags.has(key)) return fail(REASON.NOT_FOUND)
      const removed = tags.get(key)
      tags.delete(key)
      if (tags.size === 0) this.files.delete(path)
      return done(REASON.OK, { tagName: removed })
    })
  }

  /**
   * Forget the record for a path, and every record beneath it when the path is a folder.
   * Only the index is touched — the markdown files themselves are never modified.
   * Returns the dropped records so the caller can report what was forgotten.
   *
   * Path comparison is case-insensitive here (as in `findStale`), because on Windows a
   * folder delete and the indexed spelling of its children can differ in case.
   */
  async deleteRecords(relativePath) {
    const target = normalizeRelative(relativePath)
    if (!target) return fail(REASON.PATH_INVALID)

    return this._mutate(() => {
      const targetKey = target.toLowerCase()
      const prefixKey = `${targetKey}/`
      const victims = this.filePaths.filter(filePath => {
        const key = filePath.toLowerCase()
        return key === targetKey || key.startsWith(prefixKey)
      })
      if (!victims.length) return fail(REASON.NOT_FOUND)

      const removed = victims.map(filePath => ({ filePath, tags: this.getFileTags(filePath) }))
      victims.forEach(filePath => this.files.delete(filePath))
      return done(REASON.OK, { removed })
    })
  }

  /**
   * Move a record to a new path, keeping its tags.
   * A record already sitting at the destination is dropped, matching KBManager: it can only
   * be a leftover from a file that is no longer there, and because tags live on the file row
   * this cannot affect any other file's tags.
   */
  async renameFile(oldPath, newPath) {
    const from = normalizeRelative(oldPath)
    const to = normalizeRelative(newPath)
    if (!from || !to) return fail(REASON.PATH_INVALID)
    if (from === to) return done(REASON.OK, { filePath: to, unchanged: true })

    return this._mutate(() => {
      const tags = this.files.get(from)
      if (!tags) return fail(REASON.NOT_FOUND)
      const folded = this.files.get(to) ? this.getFileTags(to) : []
      this.files.delete(from)
      this.files.set(to, tags)
      return done(REASON.OK, { filePath: to, folded })
    })
  }

  /** Drop every record whose file is gone from disk. */
  async pruneStale(pathsOnDisk) {
    // Check writability before the empty-result shortcut, otherwise a corrupt index would
    // report "nothing to do" as success instead of refusing the operation.
    if (!this.store.indexPath) return fail(REASON.NO_REPOSITORY)
    if (this.readOnly) return fail(REASON.CORRUPT_INDEX)

    const stale = this.findStale(pathsOnDisk)
    if (!stale.length) return done(REASON.OK, { removed: [] })

    return this._mutate(() => {
      stale.forEach(filePath => this.files.delete(filePath))
      return done(REASON.OK, { removed: stale })
    })
  }

  /** Forget everything. Used to recover from a corrupt index after the user confirms. */
  async reset() {
    if (!this.store.indexPath) return fail(REASON.NO_REPOSITORY)
    const snapshot = this.toJSON()
    this.files = new Map()
    try {
      await this.store.save(this.toJSON())
    } catch (err) {
      this.files = TagRepository._toMap(snapshot)
      return fail(REASON.WRITE_FAILED, { error: err })
    }
    this.status = STATUS.OK
    this.issues = []
    return done()
  }

  // ---- internals ------------------------------------------------------------

  /** Apply a mutation, persist it, and roll back if the write fails. */
  async _mutate(apply) {
    if (!this.store.indexPath) return fail(REASON.NO_REPOSITORY)
    if (this.readOnly) return fail(REASON.CORRUPT_INDEX)

    const snapshot = this.toJSON()
    let result
    try {
      result = apply()
    } catch (err) {
      this.files = TagRepository._toMap(snapshot)
      return fail(REASON.WRITE_FAILED, { error: err })
    }
    if (!result || !result.success || !result.changed) return result

    try {
      await this.store.save(this.toJSON())
    } catch (err) {
      this.files = TagRepository._toMap(snapshot)
      return fail(REASON.WRITE_FAILED, { error: err })
    }
    this.status = STATUS.OK
    return result
  }

  /** tagKey -> { display, count }; display is the most common spelling, ties broken by name. */
  _groupByTag() {
    const groups = new Map()
    this.files.forEach(tags => {
      tags.forEach((display, key) => {
        let entry = groups.get(key)
        if (!entry) {
          entry = { spellings: new Map(), count: 0 }
          groups.set(key, entry)
        }
        entry.count += 1
        entry.spellings.set(display, (entry.spellings.get(display) || 0) + 1)
      })
    })

    const result = new Map()
    groups.forEach((entry, key) => {
      const display = [...entry.spellings.entries()]
        .sort((a, b) => (b[1] - a[1]) || TagRepository._compare(a[0], b[0]))[0][0]
      result.set(key, { display, count: entry.count })
    })
    return result
  }

  static _validateTag(tagName) {
    const name = normalizeTagName(tagName)
    if (!name) return { ok: false, reason: REASON.EMPTY_TAG }
    if (name.length > MAX_TAG_LENGTH) return { ok: false, reason: REASON.TAG_TOO_LONG }
    if (/[\r\n\t]/.test(name)) return { ok: false, reason: REASON.TAG_INVALID }
    return { ok: true, name }
  }

  static _compare(a, b) {
    const left = a.toLowerCase()
    const right = b.toLowerCase()
    if (left < right) return -1
    if (left > right) return 1
    return a < b ? -1 : a > b ? 1 : 0
  }
}

module.exports = { TagRepository, REASON }
