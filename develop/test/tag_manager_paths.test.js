const assert = require("node:assert/strict")
const test = require("node:test")

const paths = require("../../plugin/tag_manager/paths")

test("normalizes a path into the canonical forward-slash index key", () => {
  assert.equal(paths.normalizeRelative("notes\\a.md"), "notes/a.md")
  assert.equal(paths.normalizeRelative("./notes/./a.md"), "notes/a.md")
  assert.equal(paths.normalizeRelative("notes/sub/../a.md"), "notes/a.md")
  assert.equal(paths.normalizeRelative("  notes/a.md  "), "notes/a.md")
})

test("rejects anything that cannot be an in-repo relative path", () => {
  assert.equal(paths.normalizeRelative(""), "")
  assert.equal(paths.normalizeRelative("/etc/passwd"), "")
  assert.equal(paths.normalizeRelative("C:/Windows/a.md"), "")
  assert.equal(paths.normalizeRelative("../outside.md"), "")
  assert.equal(paths.normalizeRelative("notes/../../outside.md"), "")
})

test("resolves an absolute path against the repository root", () => {
  assert.equal(paths.relativeFrom("/root/kb", "/root/kb/notes/a.md"), "notes/a.md")
  // Outside the repository there is no valid index key.
  assert.equal(paths.relativeFrom("/root/kb", "/root/elsewhere/a.md"), "")
})

test("excludes only directory segments, not the file name itself", () => {
  const excluded = [".git", ".kbdatabase"]
  assert.equal(paths.isExcluded(".git/a.md", excluded), true)
  assert.equal(paths.isExcluded("notes/.git/a.md", excluded), true)
  assert.equal(paths.isExcluded(".kbdatabase/tags.json", excluded), true)
  assert.equal(paths.isExcluded("notes/a.md", excluded), false)
  // A file merely named like an excluded directory stays indexable.
  assert.equal(paths.isExcluded("notes/.git", excluded), false)
})

test("accepts extensions with or without a leading dot and case-insensitively", () => {
  assert.deepEqual(paths.normalizeExtensions(["md", ".TXT"]), [".md", ".txt"])
  assert.deepEqual(paths.normalizeExtensions([]), paths.DEFAULT_MARKDOWN_EXT)
  assert.deepEqual(paths.normalizeExtensions(null), paths.DEFAULT_MARKDOWN_EXT)

  assert.equal(paths.hasAllowedExtension("a.MD", ["md"]), true)
  assert.equal(paths.hasAllowedExtension("a.markdown", [".markdown"]), true)
  assert.equal(paths.hasAllowedExtension("a.txt", ["md"]), false)
  assert.equal(paths.hasAllowedExtension("a.md.bak", ["md"]), false)
  assert.equal(paths.hasAllowedExtension("noext", ["md"]), false)
})

test("isIndexablePath combines every scan rule", () => {
  const root = "/root/kb"
  assert.equal(paths.isIndexablePath(root, "/root/kb/x.md", {}), true)
  assert.equal(paths.isIndexablePath(root, "/root/kb/deep/x.MD", {}), true)
  assert.equal(paths.isIndexablePath(root, "/root/kb/.git/x.md", {}), false)
  assert.equal(paths.isIndexablePath(root, "/root/kb/.kbdatabase/tags.json", {}), false)
  assert.equal(paths.isIndexablePath(root, "/root/kb/.hidden.md", {}), false)
  assert.equal(paths.isIndexablePath(root, "/root/kb/x.png", {}), false)
  assert.equal(paths.isIndexablePath(root, "/root/other/x.md", {}), false)
})

test("isHiddenName treats a leading dot as hidden on every platform", () => {
  assert.equal(paths.isHiddenName(".hidden.md"), true)
  assert.equal(paths.isHiddenName("visible.md"), false)
  assert.equal(paths.isHiddenName(""), false)
})

test("tag identity is case-insensitive while the display spelling is preserved", () => {
  assert.equal(paths.normalizeTagName("  Git  "), "Git")
  assert.equal(paths.tagKey("  Git  "), "git")
  assert.equal(paths.tagKey("GIT"), paths.tagKey("git"))
})

test("basename and dirname work on forward-slash keys", () => {
  assert.equal(paths.basename("notes/sub/a.md"), "a.md")
  assert.equal(paths.basename("a.md"), "a.md")
  assert.equal(paths.dirname("notes/sub/a.md"), "notes/sub")
  assert.equal(paths.dirname("a.md"), "")
})
