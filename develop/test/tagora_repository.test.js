const assert = require("node:assert/strict")
const test = require("node:test")

const { TagRepository, REASON } = require("../../plugin/tagora/repository")
const { STATUS } = require("../../plugin/tagora/store")

/** In-memory stand-in for TagIndexStore: same surface, no disk. */
const createFakeStore = (initial = { files: {} }) => {
  const state = { saved: null, status: STATUS.MISSING, index: initial, failWrite: false }
  return {
    indexPath: "/root/kb/.kbdatabase/tags.json",
    state,
    load: async () => ({ status: state.status, index: state.index, issues: state.issues || [] }),
    save: async index => {
      if (state.failWrite) throw new Error("disk full")
      state.saved = JSON.parse(JSON.stringify(index))
    },
  }
}

const loadRepo = async (store = createFakeStore()) => {
  const repo = new TagRepository({ store })
  await repo.load()
  return { repo, store }
}

test("a fresh repository is empty and writable", async () => {
  const { repo } = await loadRepo()
  assert.equal(repo.isNew, true)
  assert.equal(repo.readOnly, false)
  assert.equal(repo.fileCount, 0)
  assert.equal(repo.tagCount, 0)
  assert.deepEqual(repo.listFiles(), [])
})

test("addTag trims, persists immediately, and rejects duplicates case-insensitively", async () => {
  const { repo, store } = await loadRepo()

  const added = await repo.addTag("notes/a.md", "  Git ")
  assert.equal(added.success, true)
  assert.equal(added.tagName, "Git")
  assert.deepEqual(repo.getFileTags("notes/a.md"), ["Git"])
  assert.deepEqual(store.state.saved.files["notes/a.md"], ["Git"])

  const duplicate = await repo.addTag("notes/a.md", "git")
  assert.equal(duplicate.success, false)
  assert.equal(duplicate.reason, REASON.DUPLICATE)
  assert.deepEqual(repo.getFileTags("notes/a.md"), ["Git"])
})

test("the spelling already in use is reused so one tag cannot split into two", async () => {
  const { repo } = await loadRepo()
  await repo.addTag("notes/a.md", "Git")
  await repo.addTag("notes/b.md", "git")
  await repo.addTag("notes/c.md", "GIT")

  assert.equal(repo.tagCount, 1)
  assert.deepEqual(repo.getFileTags("notes/b.md"), ["Git"])
  assert.deepEqual(repo.tagsWithCounts(), [{ tagName: "Git", fileCount: 3 }])
})

test("tag names are validated", async () => {
  const { repo } = await loadRepo()
  assert.equal((await repo.addTag("a.md", "   ")).reason, REASON.EMPTY_TAG)
  assert.equal((await repo.addTag("a.md", null)).reason, REASON.EMPTY_TAG)
  assert.equal((await repo.addTag("a.md", "x".repeat(101))).reason, REASON.TAG_TOO_LONG)
  assert.equal((await repo.addTag("a.md", "x".repeat(100))).success, true)
  assert.equal((await repo.addTag("a.md", "two\nlines")).reason, REASON.TAG_INVALID)
  assert.equal((await repo.addTag("a.md", "tab\there")).reason, REASON.TAG_INVALID)
  assert.equal((await repo.addTag("", "ok")).reason, REASON.PATH_INVALID)
  assert.equal((await repo.addTag("../escape.md", "ok")).reason, REASON.PATH_INVALID)
})

test("removeTag drops the record once its last tag is gone", async () => {
  const { repo } = await loadRepo()
  await repo.addTag("notes/a.md", "Git")
  await repo.addTag("notes/a.md", "架构")

  assert.equal((await repo.removeTag("notes/a.md", "git")).success, true)
  assert.deepEqual(repo.getFileTags("notes/a.md"), ["架构"])

  assert.equal((await repo.removeTag("notes/a.md", "架构")).success, true)
  assert.equal(repo.hasFile("notes/a.md"), false)
  assert.equal(repo.fileCount, 0)
  assert.deepEqual(repo.listFiles(), [])

  assert.equal((await repo.removeTag("notes/a.md", "架构")).reason, REASON.NOT_FOUND)
  assert.equal((await repo.removeTag("notes/a.md", "")).reason, REASON.EMPTY_TAG)
})

test("tagsWithCounts orders by usage then by name", async () => {
  const { repo } = await loadRepo()
  await repo.addTag("a.md", "架构")
  await repo.addTag("b.md", "架构")
  await repo.addTag("a.md", "Git")
  await repo.addTag("b.md", "Git")
  await repo.addTag("a.md", "Zebra")

  assert.deepEqual(repo.tagsWithCounts(), [
    { tagName: "Git", fileCount: 2 },
    { tagName: "架构", fileCount: 2 },
    { tagName: "Zebra", fileCount: 1 },
  ])
  assert.equal(repo.tagCount, 3)
})

test("searchByTag matches exactly but case-insensitively, and reports every tag of a hit", async () => {
  const { repo } = await loadRepo()
  await repo.addTag("notes/a.md", "Git")
  await repo.addTag("notes/a.md", "架构")
  await repo.addTag("journal/c.md", "架构")
  await repo.addTag("notes/b.md", "Github")

  assert.deepEqual(repo.searchByTag("架构").map(row => row.filePath), ["journal/c.md", "notes/a.md"])
  assert.deepEqual(repo.searchByTag("架构")[1].tags, ["Git", "架构"])
  // Exact match only: "Git" must not sweep in "Github".
  assert.deepEqual(repo.searchByTag("git").map(row => row.filePath), ["notes/a.md"])
  assert.deepEqual(repo.searchByTag(""), [])
})

test("suggestTags excludes owned tags, matches substrings and honours the limit", async () => {
  const { repo } = await loadRepo()
  await repo.addTag("a.md", "架构")
  await repo.addTag("b.md", "架构")
  await repo.addTag("a.md", "Git")
  await repo.addTag("c.md", "GitHub")
  await repo.addTag("d.md", "Gist")

  // Ordering is usage count first, then case-insensitive name (KBManager's rule).
  assert.deepEqual(repo.suggestTags("", { exclude: ["Git"] }).map(s => s.tagName), ["架构", "Gist", "GitHub"])
  assert.deepEqual(repo.suggestTags("gi").map(s => s.tagName), ["Gist", "Git", "GitHub"])
  assert.deepEqual(repo.suggestTags("", { limit: 2 }).map(s => s.tagName), ["架构", "Gist"])
  assert.deepEqual(repo.suggestTags("nothing"), [])
})

test("listFiles carries each file's complete tag set, ordered by path", async () => {
  const { repo } = await loadRepo()
  await repo.addTag("notes/b.md", "Git")
  await repo.addTag("a.md", "架构")
  await repo.addTag("notes/b.md", "架构")

  assert.deepEqual(repo.listFiles(), [
    { filePath: "a.md", tags: ["架构"] },
    { filePath: "notes/b.md", tags: ["Git", "架构"] },
  ])
})

test("deleteRecords drops one file's record without touching other files", async () => {
  const { repo } = await loadRepo()
  await repo.addTag("a.md", "Git")
  await repo.addTag("b.md", "Git")

  const deleted = await repo.deleteRecords("a.md")
  assert.equal(deleted.success, true)
  assert.deepEqual(deleted.removed, [{ filePath: "a.md", tags: ["Git"] }])
  assert.equal(repo.hasFile("a.md"), false)
  // Because tags live on the file row, the other file keeps its tag with no GC bookkeeping.
  assert.deepEqual(repo.getFileTags("b.md"), ["Git"])

  assert.equal((await repo.deleteRecords("a.md")).reason, REASON.NOT_FOUND)
  assert.equal((await repo.deleteRecords("")).reason, REASON.PATH_INVALID)
})

test("deleteRecords on a folder drops every record beneath it and nothing else", async () => {
  const { repo } = await loadRepo()
  await repo.addTag("notes/a.md", "Git")
  await repo.addTag("notes/deep/b.md", "架构")
  await repo.addTag("notes.md", "架构")
  await repo.addTag("journal/c.md", "架构")

  const result = await repo.deleteRecords("notes")
  assert.equal(result.success, true)
  assert.deepEqual(result.removed.map(entry => entry.filePath), ["notes/a.md", "notes/deep/b.md"])
  // "notes.md" merely starts with the same letters and must survive a folder delete.
  assert.deepEqual(repo.filePaths, ["journal/c.md", "notes.md"])

  assert.equal((await repo.deleteRecords("empty-folder")).reason, REASON.NOT_FOUND)
})

test("deleteRecords matches case-insensitively, as findStale does", async () => {
  const { repo } = await loadRepo()
  await repo.addTag("Notes/A.md", "Git")
  await repo.addTag("notes/b.md", "Git")
  await repo.addTag("other.md", "Git")

  const result = await repo.deleteRecords("NOTES")
  assert.equal(result.success, true)
  assert.deepEqual(result.removed.map(entry => entry.filePath), ["Notes/A.md", "notes/b.md"])
  assert.deepEqual(repo.filePaths, ["other.md"])
})

test("a failed write during deleteRecords rolls the records back", async () => {
  const store = createFakeStore()
  const { repo } = await loadRepo(store)
  await repo.addTag("notes/a.md", "Git")

  store.state.failWrite = true
  const failed = await repo.deleteRecords("notes")
  assert.equal(failed.reason, REASON.WRITE_FAILED)
  assert.deepEqual(repo.getFileTags("notes/a.md"), ["Git"])
})

test("renameFile moves a record with its tags and drops a stale record at the destination", async () => {
  const { repo } = await loadRepo()
  await repo.addTag("notes/a.md", "Git")
  await repo.addTag("notes/a.md", "架构")
  await repo.addTag("stale.md", "old")

  const result = await repo.renameFile("notes/a.md", "stale.md")
  assert.equal(result.success, true)
  assert.deepEqual(result.folded, ["old"])
  assert.equal(repo.hasFile("notes/a.md"), false)
  assert.deepEqual(repo.getFileTags("stale.md"), ["Git", "架构"])

  assert.equal((await repo.renameFile("missing.md", "x.md")).reason, REASON.NOT_FOUND)
  assert.equal((await repo.renameFile("", "x.md")).reason, REASON.PATH_INVALID)
  const unchanged = await repo.renameFile("stale.md", "stale.md")
  assert.equal(unchanged.success, true)
  assert.equal(unchanged.unchanged, true)
})

test("findStale compares against disk case-insensitively; pruneStale removes only those rows", async () => {
  const { repo } = await loadRepo()
  await repo.addTag("journal/c.md", "架构")
  await repo.addTag("gone.md", "old")

  assert.deepEqual(repo.findStale(["journal/c.md"]), ["gone.md"])
  // A case difference on the path that IS on disk must not be reported as missing.
  assert.deepEqual(repo.findStale(["JOURNAL/C.MD", "gone.md"]), [])
  assert.deepEqual(repo.findStale(["JOURNAL/C.MD"]), ["gone.md"])

  const pruned = await repo.pruneStale(["journal/c.md"])
  assert.deepEqual(pruned.removed, ["gone.md"])
  assert.equal(repo.fileCount, 1)
  assert.deepEqual(repo.getFileTags("journal/c.md"), ["架构"])

  const again = await repo.pruneStale(["journal/c.md"])
  assert.deepEqual(again.removed, [])
})

test("a failed write rolls the in-memory index back", async () => {
  const store = createFakeStore()
  const { repo } = await loadRepo(store)
  await repo.addTag("notes/a.md", "Git")

  store.state.failWrite = true
  const failed = await repo.addTag("notes/a.md", "架构")
  assert.equal(failed.success, false)
  assert.equal(failed.reason, REASON.WRITE_FAILED)
  // Memory must not claim a tag that never reached the disk.
  assert.deepEqual(repo.getFileTags("notes/a.md"), ["Git"])

  store.state.failWrite = false
  assert.equal((await repo.addTag("notes/a.md", "架构")).success, true)
})

test("a corrupt index is read-only until it is explicitly reset", async () => {
  const store = createFakeStore()
  store.state.status = STATUS.CORRUPT
  store.state.issues = ["index is not valid JSON"]
  const { repo } = await loadRepo(store)

  assert.equal(repo.readOnly, true)
  assert.equal((await repo.addTag("a.md", "x")).reason, REASON.CORRUPT_INDEX)
  assert.equal((await repo.removeTag("a.md", "x")).reason, REASON.CORRUPT_INDEX)
  assert.equal((await repo.pruneStale([])).reason, REASON.CORRUPT_INDEX)

  const reset = await repo.reset()
  assert.equal(reset.success, true)
  assert.equal(repo.readOnly, false)
  assert.deepEqual(store.state.saved.files, {})
  assert.equal((await repo.addTag("a.md", "x")).success, true)
})

test("the index document is created lazily by the first tag", async () => {
  const store = createFakeStore()
  const { repo } = await loadRepo(store)
  assert.equal(store.state.saved, null, "reading must not write")

  await repo.addTag("a.md", "Git")
  assert.deepEqual(store.state.saved.files, { "a.md": ["Git"] })
})

test("duplicate spellings already in the index collapse to the most common one", async () => {
  const store = createFakeStore({
    files: { "a.md": ["Git"], "b.md": ["Git"], "c.md": ["git"] },
  })
  const { repo } = await loadRepo(store)

  assert.equal(repo.tagCount, 1)
  assert.deepEqual(repo.tagsWithCounts(), [{ tagName: "Git", fileCount: 3 }])
  assert.deepEqual(repo.searchByTag("GIT").map(row => row.filePath), ["a.md", "b.md", "c.md"])
})

test("a path that would collide with Object.prototype is rejected, not silently applied", async () => {
  const { serializeIndex, reviveIndex } = require("../../plugin/tagora/store")

  // JSON.parse creates a real own property named __proto__, which an object literal cannot.
  const hostile = JSON.parse('{"__proto__": ["x"], "ok.md": ["y"]}')
  const { index, issues } = reviveIndex({ version: 1, files: hostile })
  assert.deepEqual(Object.keys(index.files), ["ok.md"])
  assert.ok(issues.some(issue => issue.includes("__proto__")))

  const store = createFakeStore()
  const { repo } = await loadRepo(store)
  await repo.addTag("__proto__", "x")
  const text = serializeIndex(repo.toJSON())
  assert.equal(text.includes("__proto__"), false)
  assert.deepEqual(JSON.parse(text).files, {})
})

test("the index key survives a round trip through serialisation", async () => {
  const { serializeIndex, reviveIndex } = require("../../plugin/tagora/store")
  const store = createFakeStore()
  const { repo } = await loadRepo(store)
  await repo.addTag("notes/a.md", "Git")
  await repo.addTag("notes/a.md", "架构")

  const { index } = reviveIndex(JSON.parse(serializeIndex(repo.toJSON())))
  assert.deepEqual(index.files, { "notes/a.md": ["Git", "架构"] })
})
