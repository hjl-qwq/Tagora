const assert = require("node:assert/strict")
const test = require("node:test")
const os = require("node:os")
const path = require("node:path")
const fs = require("fs-extra")

const store = require("../../plugin/tagora/store")

const makeStore = async (indexFile) => {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "typora-tag-manager-"))
  return {
    repoDir,
    store: new store.TagIndexStore({ repoDir, indexFile }),
    cleanup: () => fs.remove(repoDir),
  }
}

test("load() reports a missing index instead of failing", async () => {
  const { store: s, cleanup } = await makeStore()
  try {
    const result = await s.load()
    assert.equal(result.status, store.STATUS.MISSING)
    assert.deepEqual(result.index.files, {})
    assert.equal(await s.exists(), false)
  } finally {
    await cleanup()
  }
})

test("save() creates the index directory and round-trips through load()", async () => {
  const { store: s, cleanup } = await makeStore()
  try {
    assert.equal(s.indexPath, path.join(s.repoDir, store.DEFAULT_INDEX_FILE))

    await s.save({ files: { "notes/a.md": ["Git", "架构"] } })
    assert.equal(await s.exists(), true)

    const result = await s.load()
    assert.equal(result.status, store.STATUS.OK)
    assert.deepEqual(result.index.files, { "notes/a.md": ["Git", "架构"] })
    assert.deepEqual(result.issues, [])
  } finally {
    await cleanup()
  }
})

test("serialisation is deterministic and diff-friendly", async () => {
  const { store: s, cleanup } = await makeStore()
  try {
    // Untagged rows are dropped, paths and tags are sorted, duplicate spellings collapse.
    const text = store.serializeIndex({
      files: {
        "notes/b.md": ["git"],
        "a.md": [],
        "journal/c.md": ["重构", "架构"],
        "notes/a.md": ["Git", "git"],
      },
    })
    const parsed = JSON.parse(text)
    assert.deepEqual(Object.keys(parsed.files), ["journal/c.md", "notes/a.md", "notes/b.md"])
    assert.deepEqual(parsed.files["notes/a.md"], ["Git"])
    assert.equal(parsed.version, store.INDEX_VERSION)

    // One path per line means adding a tag touches exactly one line.
    assert.equal(text, store.serializeIndex(JSON.parse(text)))

    await s.save({ files: { "b.md": ["x"] } })
    const second = await s.load()
    assert.deepEqual(second.index.files, { "b.md": ["x"] })
    await s.save(second.index)
    const third = await fs.readFile(s.indexPath, "utf-8")
    assert.equal(third.endsWith("\n"), true)
  } finally {
    await cleanup()
  }
})

test("save() leaves no temporary file behind", async () => {
  const { repoDir, store: s, cleanup } = await makeStore()
  try {
    await s.save({ files: { "a.md": ["x"] } })
    const entries = await fs.readdir(path.join(repoDir, ".kbdatabase"))
    assert.deepEqual(entries, ["tags.json"])
  } finally {
    await cleanup()
  }
})

test("an unparseable index is reported as corrupt and is never overwritten by load()", async () => {
  const { store: s, cleanup } = await makeStore()
  try {
    const target = s.indexPath
    await fs.ensureDir(path.dirname(target))
    await fs.writeFile(target, "{ this is not json", "utf-8")

    const result = await s.load()
    assert.equal(result.status, store.STATUS.CORRUPT)
    assert.ok(result.issues.length > 0)

    // The bytes on disk must survive a read.
    assert.equal(await fs.readFile(target, "utf-8"), "{ this is not json")
  } finally {
    await cleanup()
  }
})

test("reviveIndex drops unusable rows and reports them", () => {
  const { index, issues } = store.reviveIndex({
    version: 1,
    files: {
      "notes/a.md": ["Git", "  ", "Git", 42],
      "../escape.md": ["x"],
      "/abs.md": ["x"],
      "notes/b.md": "not-an-array",
    },
  })

  assert.deepEqual(Object.keys(index.files), ["notes/a.md"])
  assert.deepEqual(index.files["notes/a.md"], ["Git"])
  assert.ok(issues.some(issue => issue.includes("../escape.md")))
  assert.ok(issues.some(issue => issue.includes("non-array")))
})

test("reviveIndex rejects a document that is not an index at all", () => {
  for (const value of [null, [], 42, {}, { files: [] }]) {
    const { index, issues } = store.reviveIndex(value)
    assert.equal(issues.length > 0, true)
    assert.deepEqual(index.files, {})
  }
})

test("an absolute INDEX_FILE is used as given instead of being joined to the repository", async () => {
  const { repoDir, cleanup } = await makeStore()
  const external = path.join(os.tmpdir(), `typora-tag-manager-external-${Date.now()}.json`)
  try {
    const s = new store.TagIndexStore({ repoDir, indexFile: external })
    assert.equal(s.indexPath, external)
    await s.save({ files: { "a.md": ["x"] } })
    assert.equal(await fs.pathExists(external), true)
  } finally {
    await fs.remove(external)
    await cleanup()
  }
})
