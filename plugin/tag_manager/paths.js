const PATH = require("path")

/**
 * Path rules for the tag index.
 *
 * These mirror the rules KBManager.core used (FileScanService / FileContentService) so an
 * existing knowledge base keeps behaving the same way after the move to Typora:
 *   - the index key is always a repo-relative path with forward slashes
 *   - absolute paths, drive letters and UNC prefixes are rejected
 *   - `.` / `..` segments are collapsed; escaping the repo root is rejected
 *   - only markdown-ish extensions are indexed, and only non-hidden files
 *
 * Kept free of Typora globals on purpose so it can be unit tested with node:test.
 */

const DEFAULT_MARKDOWN_EXT = [".md", ".markdown", ".mdown", ".mkd", ".mkdn", ".mdwn"]
const DEFAULT_EXCLUDE_DIRS = [".git", ".kbdatabase"]
const MAX_RELATIVE_PATH_LENGTH = 500
const MAX_TAG_LENGTH = 100

/** Accept both `md` and `.md`, normalise to a lowercase leading-dot form. */
const normalizeExtensions = (extensions) => {
  const list = Array.isArray(extensions) && extensions.length ? extensions : DEFAULT_MARKDOWN_EXT
  const seen = new Set()
  list.forEach(ext => {
    const value = String(ext == null ? "" : ext).trim().toLowerCase()
    if (!value) return
    seen.add(value.startsWith(".") ? value : `.${value}`)
  })
  return seen.size ? [...seen] : [...DEFAULT_MARKDOWN_EXT]
}

const toForwardSlash = value => String(value == null ? "" : value).replace(/\\/g, "/")

const isAbsolute = value => value.startsWith("/") || /^[a-zA-Z]:($|\/)/.test(value)

/**
 * Normalise any user- or Typora-supplied path into the canonical index key.
 * Returns "" when the value cannot be represented as an in-repo relative path.
 */
const normalizeRelative = value => {
  const raw = toForwardSlash(value).trim()
  if (!raw || isAbsolute(raw)) return ""

  const segments = []
  for (const segment of raw.split("/")) {
    if (!segment || segment === ".") continue
    if (segment === "..") {
      // Popping past the root means the path points outside the repository.
      if (segments.length === 0) return ""
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return segments.join("/")
}

/** Repo-relative index key for an absolute path, or "" when it escapes the root. */
const relativeFrom = (rootDir, absolutePath) => {
  if (!rootDir || !absolutePath) return ""
  const relative = PATH.relative(PATH.resolve(rootDir), PATH.resolve(absolutePath))
  return normalizeRelative(relative)
}

const basename = filePath => {
  const normalized = toForwardSlash(filePath)
  const index = normalized.lastIndexOf("/")
  return index === -1 ? normalized : normalized.slice(index + 1)
}

const dirname = filePath => {
  const normalized = toForwardSlash(filePath)
  const index = normalized.lastIndexOf("/")
  return index === -1 ? "" : normalized.slice(0, index)
}

/** `true` when any *directory* segment of the path is excluded (the file name itself is not checked). */
const isExcluded = (filePath, excludeDirs) => {
  const dirs = (Array.isArray(excludeDirs) && excludeDirs.length ? excludeDirs : DEFAULT_EXCLUDE_DIRS)
    .map(name => String(name == null ? "" : name).trim().toLowerCase())
    .filter(Boolean)
  if (dirs.length === 0) return false

  const excluded = new Set(dirs)
  const normalized = normalizeRelative(filePath)
  const segments = normalized.split("/")
  segments.pop()
  return segments.some(segment => excluded.has(segment.toLowerCase()))
}

/** Dot-prefixed files are treated as hidden on every platform (Typora runs on Windows and Linux). */
const isHiddenName = name => String(name == null ? "" : name).startsWith(".")

const hasAllowedExtension = (name, extensions) => {
  const ext = PATH.extname(String(name == null ? "" : name)).toLowerCase()
  if (!ext) return false
  return normalizeExtensions(extensions).includes(ext)
}

/** All the rules a candidate absolute path must pass before it earns an index row. */
const isIndexablePath = (rootDir, absolutePath, { extensions, excludeDirs } = {}) => {
  const name = PATH.basename(absolutePath)
  if (!name || isHiddenName(name)) return false
  if (!hasAllowedExtension(name, extensions)) return false

  const relative = relativeFrom(rootDir, absolutePath)
  if (!relative) return false
  if (relative.length > MAX_RELATIVE_PATH_LENGTH) return false
  if (isExcluded(relative, excludeDirs)) return false
  return true
}

const normalizeTagName = value => String(value == null ? "" : value).trim()

/** Lowercase grouping key. Tag identity is case-insensitive; see repository.js. */
const tagKey = value => normalizeTagName(value).toLowerCase()

module.exports = {
  DEFAULT_MARKDOWN_EXT,
  DEFAULT_EXCLUDE_DIRS,
  MAX_RELATIVE_PATH_LENGTH,
  MAX_TAG_LENGTH,
  normalizeExtensions,
  normalizeRelative,
  relativeFrom,
  toForwardSlash,
  basename,
  dirname,
  isExcluded,
  isHiddenName,
  hasAllowedExtension,
  isIndexablePath,
  normalizeTagName,
  tagKey,
}
