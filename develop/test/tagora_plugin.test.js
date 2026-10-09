const assert = require("node:assert/strict")
const test = require("node:test")
const fs = require("node:fs")
const path = require("node:path")

global.BasePlugin = class {
  i18n = { t: key => key }
}

const { plugin: TagManagerPlugin } = require("../../plugin/tagora")
const paths = require("../../plugin/tagora/paths")
const { REASON } = require("../../plugin/tagora/repository")

const PLUGIN_DIR = path.resolve(__dirname, "../../plugin/tagora")

const createInstance = () => {
  const instance = new TagManagerPlugin()
  instance.pluginName = "标签管理"
  instance.i18n = { t: (key, vars) => (vars ? `${key}(${JSON.stringify(vars)})` : key) }
  instance.config = {
    HOTKEY: "ctrl+shift+k",
    INDEX_FILE: ".kbdatabase/tags.json",
    MARKDOWN_EXT: [".md"],
    EXCLUDE_DIRS: [".git", ".kbdatabase"],
    SUGGESTION_LIMIT: 10,
    SHOW_TREE_BADGE: true,
  }
  return instance
}

test("uses the shared window component and hides until invoked", () => {
  const html = createInstance().html()
  assert.match(html, /id="plugin-tag-manager"/)
  assert.match(html, /class="tag-manager-mask plugin-common-hidden"/)
  assert.match(html, /class="tag-manager-dialog"[^>]*role="dialog"[^>]*aria-modal="true"/)
  // A centred mask, never a draggable floating window.
  assert.doesNotMatch(html, /<fast-window/)
  // Theme-safe UI: no native form controls other than a text input.
  assert.doesNotMatch(html, /<\/?(?:select|option|button)\b/i)
})

test("the dialog header carries its own sync and close controls", () => {
  const html = createInstance().html()
  assert.match(html, /tag-manager-sync fa fa-refresh/)
  assert.match(html, /tag-manager-close ion-close-round/)
  assert.match(html, /tag-manager-back fa fa-arrow-left plugin-common-hidden/)
  assert.match(html, /tag-manager-clean fa fa-trash plugin-common-hidden/)
})

test("registers the configured hotkey", () => {
  const instance = createInstance()
  assert.deepEqual(instance.hotkey(), [{ hotkey: "ctrl+shift+k", callback: instance.call }])
})

test("loads its own stylesheet without template variables", () => {
  assert.equal(createInstance().style(), true)
  assert.equal(fs.existsSync(path.join(PLUGIN_DIR, "index.css")), true)
})

test("every selector init() queries exists in html()", () => {
  const html = createInstance().html()
  const source = fs.readFileSync(path.join(PLUGIN_DIR, "index.js"), "utf-8")
  const queried = [...source.matchAll(/query\("(#plugin-[a-z-]+)[^"]*"\)/g)].map(m => m[0].slice(7, -2))

  assert.ok(queried.length > 0, "init() queries nothing")
  assert.deepEqual(queried.sort(), [...new Set(queried)].sort(), "duplicate selector in init()")

  for (const selector of queried) {
    // "#plugin-tag-manager .tag-manager-status" -> id="plugin-tag-manager" + the class below it.
    const [id, ...rest] = selector.split(" ")
    const idName = id.replace(/^#/, "")
    assert.ok(html.includes(`id="${idName}"`), `html() is missing id="${idName}"`)
    for (const part of rest) {
      const className = part.replace(/^\./, "")
      const scoped = new RegExp(`id="${idName}"[\\s\\S]*?${className}`)
      assert.match(html, scoped, `html() has no ${part} under ${id}`)
    }
  }
})

test("the panel markup exposes every hook the rendering code looks for", () => {
  const html = createInstance().html()
  for (const selector of [
    "tag-manager-status",
    "tag-manager-title-doc",
    "tag-manager-doc",
    "tag-manager-chips",
    "tag-manager-input",
    "tag-manager-add",
    "tag-manager-suggest",
    "tag-manager-title-tags",
    "tag-manager-search",
    "tag-manager-tags",
    "tag-manager-title-files",
    "tag-manager-files",
  ]) {
    assert.ok(html.includes(selector), `html() is missing .${selector}`)
  }
})

test("maps repository reason codes onto locale keys", () => {
  const instance = createInstance()
  const mapped = [
    REASON.DUPLICATE,
    REASON.NOT_FOUND,
    REASON.EMPTY_TAG,
    REASON.TAG_TOO_LONG,
    REASON.TAG_INVALID,
    REASON.PATH_INVALID,
    REASON.CORRUPT_INDEX,
    REASON.NO_REPOSITORY,
    REASON.WRITE_FAILED,
  ]
  for (const reason of mapped) {
    const text = instance._reasonText({ reason })
    assert.notEqual(text, "actionFailed", `reason ${reason} has no dedicated translation`)
  }
})

test("counts tags for a file-tree row, and ignores rows outside the repository", () => {
  const instance = createInstance()
  instance.repoDir = "/root/kb"
  instance.repo = {
    getFileTags: filePath => (filePath === "notes/a.md" ? ["Git", "架构"] : []),
  }

  assert.equal(instance._tagCountForTreePath("/root/kb/notes/a.md"), 2)
  assert.equal(instance._tagCountForTreePath("/root/kb/notes/other.md"), 0)
  assert.equal(instance._tagCountForTreePath("/root/elsewhere/a.md"), 0)
  assert.equal(instance._tagCountForTreePath(""), 0)

  instance.repo = null
  assert.equal(instance._tagCountForTreePath("/root/kb/notes/a.md"), 0)
})

test("current document path is resolved against the mounted folder", () => {
  const instance = createInstance()
  instance.repoDir = "/root/kb"
  instance.utils = { getFilePath: () => "/root/kb/notes/a.md" }
  assert.equal(instance._currentFilePath(), "notes/a.md")

  instance.utils = { getFilePath: () => "/root/elsewhere/a.md" }
  assert.equal(instance._currentFilePath(), "")

  instance.utils = { getFilePath: () => "" }
  assert.equal(instance._currentFilePath(), "")
})

test("every locale key the plugin uses is defined in all three built-in locales", () => {
  const source = fs.readFileSync(path.join(PLUGIN_DIR, "index.js"), "utf-8")
  const used = new Set([...source.matchAll(/i18n\.t\("([^"]+)"/g)].map(m => m[1]))
  // Keys reached indirectly through REASON_I18N and _buildEmpty().
  ;[
    "tagDuplicate", "tagMissing", "tagEmpty", "tagTooLong", "tagInvalid",
    "pathInvalid", "indexCorrupt", "noMountFolder", "writeFailed",
    "noMatch", "noFiles", "badgeHint",
  ].forEach(key => used.add(key))

  const { MESSAGES, LOCALES } = require("../../plugin/tagora/messages")
  for (const locale of LOCALES) {
    const section = MESSAGES[locale]
    assert.ok(section, `messages.js has no ${locale} table`)
    const missing = [...used].filter(key => !Object.hasOwn(section, key))
    assert.deepEqual(missing, [], `${locale} is missing: ${missing.join(", ")}`)
  }
})

test("the built-in locales declare exactly the same keys", () => {
  const { MESSAGES, LOCALES } = require("../../plugin/tagora/messages")
  const [base, ...rest] = LOCALES
  const expected = Object.keys(MESSAGES[base]).sort()
  for (const locale of rest) {
    assert.deepEqual(Object.keys(MESSAGES[locale]).sort(), expected, `${locale} key set differs from ${base}`)
  }
})

test("bindMessages serves built-in text, interpolates, and falls back to the framework", () => {
  const { MESSAGES, bindMessages } = require("../../plugin/tagora/messages")
  const i18n = bindMessages({ locale: "zh-CN", t: key => `fw:${key}` })

  assert.equal(i18n.t("act.add"), MESSAGES["zh-CN"]["act.add"])
  assert.notEqual(i18n.t("act.add"), "act.add", "built-in text must replace the raw key")
  assert.match(i18n.t("staleSummary", { count: 3 }), /3/, "placeholders must be interpolated")
  assert.equal(i18n.t("unknownKey"), "fw:unknownKey", "unknown keys fall through to the framework")
  assert.equal(i18n.locale, "zh-CN", "the framework locale is preserved")

  // An unknown locale degrades to English instead of showing raw keys.
  assert.equal(bindMessages({ locale: "ja", t: key => key }).t("act.add"), MESSAGES.en["act.add"])
})

test("prepare() rebinds i18n and repairs pluginName when NAME is absent", async () => {
  const instance = createInstance()
  instance.i18n = { locale: "en", t: key => key }
  instance.pluginName = "pluginName"
  instance.config = {}

  await instance.prepare()

  assert.notEqual(instance.i18n.t("act.add"), "act.add")
  assert.notEqual(instance.pluginName, "pluginName", "pluginName must come from the built-in table")
})

test("stays inside the Chrome 84 compatibility boundary", () => {
  const sources = ["index.js", "index.css"].map(name => ({
    name,
    content: fs.readFileSync(path.join(PLUGIN_DIR, name), "utf-8"),
  }))

  const forbidden = [
    /\bcounter-set\s*:/g,
    /\bcolor-mix\s*\(/g,
    /:focus-visible\b/g,
    /^\s*inset\s*:/gm,
    /:has\(/g,
  ]
  for (const source of sources) {
    for (const pattern of forbidden) {
      assert.doesNotMatch(source.content, pattern, `${source.name} violates ${pattern}`)
    }
    assert.doesNotMatch(source.content, /<\/?(?:select|option|button)\b|createElement\(\s*["'](?:select|option|button)["']/i,
      `${source.name} introduces a native form control`)
  }

  // AGENTS.md: do not rely on Flexbox `gap`.
  const css = sources[1].content
  for (const block of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const declarations = block[2]
    if (/\bdisplay\s*:\s*(?:inline-)?flex\b/.test(declarations)) {
      assert.doesNotMatch(declarations, /(?:^|;)\s*(?:row-|column-)?gap\s*:/, `flex gap in selector: ${block[1].trim()}`)
    }
  }
})

test("the file-tree badge is styled outside the panel scope", () => {
  const css = fs.readFileSync(path.join(PLUGIN_DIR, "index.css"), "utf-8")
  // The badge lands in Typora's own tree, so a #plugin-tag-manager-scoped rule would never match.
  assert.match(css, /\.file-node-content\s+\.plugin-tag-manager-badge\s*\{/)
  assert.doesNotMatch(css, /#plugin-tag-manager[^{]*\.plugin-tag-manager-badge/)
})

test("the badge class used in code matches the class styled in CSS", () => {
  const source = fs.readFileSync(path.join(PLUGIN_DIR, "index.js"), "utf-8")
  const constant = source.match(/const BADGE_CLASS = "([^"]+)"/)[1]
  const css = fs.readFileSync(path.join(PLUGIN_DIR, "index.css"), "utf-8")
  assert.ok(css.includes(`.${constant}`), `CSS does not style .${constant}`)
})

test("the default index file lives inside an excluded folder", () => {
  const instance = createInstance()
  const indexFile = instance.config.INDEX_FILE
  assert.equal(paths.isExcluded(indexFile, instance.config.EXCLUDE_DIRS), true,
    "the scan would otherwise index its own index file")
})

// ---- editor entry point -------------------------------------------------------

test("contributes no editor-corner UI of its own", () => {
  const html = createInstance().html()
  assert.doesNotMatch(html, /id="plugin-tag-button"/, "the corner button belongs to action_buttons")
  assert.doesNotMatch(html, /id="plugin-tag-bar"/, "the inline tag strip is gone")
  assert.doesNotMatch(html, /<\/?(?:select|option|button)\b/i)

  const css = fs.readFileSync(path.join(PLUGIN_DIR, "index.css"), "utf8")
  assert.doesNotMatch(css, /#plugin-tag-button|#plugin-tag-bar|\.tag-bar-/)
})

// ---- installer contract -------------------------------------------------------

const MANIFEST_PATH = path.resolve(__dirname, "../../installer.toml")
const readManifest = () => fs.readFileSync(MANIFEST_PATH, "utf-8")

test("exposes call() so the right-click menu and the hotkey can reach it", () => {
  // right_click_menu invokes plugin.call(); hotkey() reuses the same entry point.
  // A plugin without call() shows up greyed out and cannot be clicked.
  assert.equal(typeof createInstance().call, "function")
})

test("ships an installer manifest that matches the on-disk layout", () => {
  const toml = readManifest()

  assert.match(toml, /^\s*id\s*=\s*"tagora"\s*$/m, "id must match the plugin folder name")
  assert.match(toml, /^\s*name\s*=\s*".+"\s*$/m, "name lands in NAME and in the menu title")
  assert.match(toml, /^\s*source\s*=\s*"plugin"\s*$/m, "source must point at the plugin/ folder")
  assert.match(toml, /^\s*files\s*=\s*\[\s*"tagora"\s*\]\s*$/m, "only plugin/tagora is installed")

  // The installer refuses to install unless the entry point exists after the copy.
  assert.equal(fs.existsSync(path.join(PLUGIN_DIR, "index.js")), true)
})

test("every config key the plugin reads has a default in the manifest", () => {
  // An installer-based install owns no settings.default.toml entry, so this.config is
  // exactly what the installer writes; a key without a default stays undefined.
  // ENABLE / NAME are excluded: the installer writes them from [plugin], not [settings].
  const reserved = new Set(["ENABLE", "NAME"])
  const source = fs.readFileSync(path.join(PLUGIN_DIR, "index.js"), "utf-8")
  const used = new Set([...source.matchAll(/this\.config\.([A-Z_][A-Z0-9_]*)/g)]
    .map(m => m[1])
    .filter(key => !reserved.has(key)))
  assert.ok(used.size > 0, "no config keys found in index.js")

  const parts = readManifest().split("[settings]")
  const settingsBlock = parts[parts.length - 1] || ""
  const missing = [...used].filter(key => !new RegExp(`^\\s*${key}\\s*=`, "m").test(settingsBlock))
  assert.deepEqual(missing, [], `installer.toml [settings] is missing: ${missing.join(", ")}`)
})

// ---- element stub shared by the rendering tests ------------------------------

const withFakeDocument = async (run) => {
  const previousDocument = global.document
  const makeElement = () => {
    const classes = new Set()
    const listeners = {}
    return {
      className: "",
      textContent: "",
      title: "",
      style: {},
      children: [],
      listeners,
      classList: {
        add: name => classes.add(name),
        remove: name => classes.delete(name),
        contains: name => classes.has(name),
      },
      appendChild(child) { this.children.push(child) },
      addEventListener(type, fn) { listeners[type] = fn },
    }
  }
  global.document = { createElement: () => makeElement() }
  try {
    return await run(makeElement)
  } finally {
    global.document = previousDocument
  }
}

// ---- delete cleanup ---------------------------------------------------------

test("_hasRecordsUnder spots records inside a folder but not a lookalike sibling", () => {
  const instance = createInstance()
  instance.repo = { filePaths: ["notes/deep/a.md", "notes.md", "other/b.md"] }

  assert.equal(instance._hasRecordsUnder("notes"), true)
  assert.equal(instance._hasRecordsUnder("notes/deep"), true)
  assert.equal(instance._hasRecordsUnder("other"), true)
  assert.equal(instance._hasRecordsUnder("missing"), false)
  // "notes.md" is a sibling, not a child of "notes".
  assert.equal(instance._hasRecordsUnder("notes.md"), false)
})

test("a removed tree row is ignored when it is a rename source or outside the repository", () => {
  const instance = createInstance()
  instance.repoDir = "/root/kb"
  instance.repo = { hasFile: filePath => filePath === "notes/a.md", filePaths: ["notes/a.md"] }

  const scheduled = []
  instance._scheduleRowCleanup = (relative, absolute) => scheduled.push(absolute)

  instance._onTreeRowRemoved("/root/kb/notes/a.md")
  assert.deepEqual(scheduled, ["/root/kb/notes/a.md"])

  instance._onTreeRowRemoved("/root/kb/notes/unknown.md")
  instance._onTreeRowRemoved("/root/elsewhere/a.md")
  instance._onTreeRowRemoved("")
  instance._onTreeRowRemoved(null)
  assert.deepEqual(scheduled, ["/root/kb/notes/a.md"], "only indexed paths may schedule a cleanup")

  instance._markRenamed("/root/kb/notes/a.md")
  instance._onTreeRowRemoved("/root/kb/notes/a.md")
  assert.deepEqual(scheduled, ["/root/kb/notes/a.md"], "a rename source must not be treated as a delete")
})

test("row removal clears the index only when the path really is gone", async () => {
  const build = ({ pathExists, renamed }) => {
    const calls = []
    const instance = createInstance()
    instance.repoDir = "/root/kb"
    instance.repo = {
      hasFile: () => true,
      filePaths: ["notes/a.md"],
      getFileTags: () => [],
      deleteRecords: async relative => {
        calls.push(relative)
        return { success: true, removed: [{ filePath: relative, tags: [] }] }
      },
    }
    instance.utils = { Package: { FsExtra: { pathExists: async () => pathExists } } }
    instance._render = () => undefined
    instance._refreshTree = () => undefined
    if (renamed) instance._markRenamed("/root/kb/notes/a.md")
    instance._scheduleRowCleanup("notes/a.md", "/root/kb/notes/a.md")
    return calls
  }

  const deleted = build({ pathExists: false, renamed: false })
  const survived = build({ pathExists: true, renamed: false })
  const renamed = build({ pathExists: false, renamed: true })

  await new Promise(resolve => setTimeout(resolve, 800))

  assert.deepEqual(deleted, ["notes/a.md"], "a deleted file must be forgotten")
  assert.deepEqual(survived, [], "a file still on disk must keep its tags")
  assert.deepEqual(renamed, [], "a rename must not be mistaken for a delete")
})

// ---- stale records view -----------------------------------------------------

test("stale records are a view inside the same dialog, not a second window", () => {
  const html = createInstance().html()
  assert.match(html, /tag-manager-view tag-manager-view-stale plugin-common-hidden/)
  assert.ok(html.includes("tag-stale-summary"))
  assert.ok(html.includes("tag-stale-list"))
  // One modal shell only: the view must live under the same dialog element.
  assert.equal([...html.matchAll(/class="tag-manager-dialog"/g)].length, 1)
  assert.doesNotMatch(html, /id="plugin-tag-stale"/)
})

test("the two views are mutually exclusive and swap the header controls", () => {
  const instance = createInstance()
  const classesOf = () => {
    const classes = new Set()
    return {
      classList: {
        add: name => classes.add(name),
        remove: name => classes.delete(name),
        contains: name => classes.has(name),
      },
      shown: () => !classes.has("plugin-common-hidden"),
    }
  }
  const viewDoc = classesOf()
  const viewStale = classesOf()
  const sync = classesOf()
  const back = classesOf()
  const clean = classesOf()
  instance.entities = {
    panel: classesOf(),
    heading: { textContent: "" },
    viewDoc, viewStale, sync, back, clean,
  }
  instance.utils = {
    show: el => el.classList.remove("plugin-common-hidden"),
    hide: el => el.classList.add("plugin-common-hidden"),
  }

  instance._showManagerView()
  assert.equal(viewDoc.shown(), true)
  assert.equal(viewStale.shown(), false)
  assert.equal(sync.shown(), true)
  assert.equal(back.shown(), false)
  assert.equal(clean.shown(), false)
  assert.equal(instance.entities.heading.textContent, instance.pluginName)
})

test("the stale window lists every record with its tags and a per-row remove control", async () => {
  await withFakeDocument(() => {
    const instance = createInstance()
    instance.repo = { getFileTags: () => ["Git", "架构"] }
    instance.staleCache = { onDisk: [], stale: ["gone/a.md", "gone/b.md"] }

    const list = { textContent: "", children: [], appendChild(c) { this.children.push(c) } }
    const summary = { textContent: "" }
    instance.entities = { staleList: list, staleSummary: summary }

    instance._renderStale()
    assert.equal(list.children.length, 2)
    assert.match(summary.textContent, /^staleSummary/)
    // The full path is shown, not only the basename.
    assert.equal(list.children[0].children[0].textContent, "gone/a.md")
    assert.equal(list.children[0].children[1].textContent, "Git · 架构")

    const remove = list.children[0].children[2]
    assert.equal(remove.className, "tag-stale-remove")
    assert.equal(remove.title, "act.removeRecord")
  })
})

test("an empty stale window says so instead of showing an empty list", async () => {
  await withFakeDocument(() => {
    const instance = createInstance()
    instance.repo = { getFileTags: () => [] }
    instance.staleCache = { onDisk: [], stale: [] }

    const list = { textContent: "", children: [], appendChild(c) { this.children.push(c) } }
    const summary = { textContent: "" }
    instance.entities = { staleList: list, staleSummary: summary }

    instance._renderStale()
    assert.equal(summary.textContent, "staleNone")
    assert.equal(list.children.length, 1)
    assert.equal(list.children[0].textContent, "staleNone")
  })
})

test("_render refreshes the stale view only while it is the visible one", async () => {
  await withFakeDocument(() => {
    const instance = createInstance()
    instance.repoDir = "/root/kb"
    instance.repo = { hasFile: () => false, filePaths: [], getFileTags: () => [], fileCount: 0, tagCount: 0 }
    instance.staleCache = { onDisk: [], stale: ["gone/a.md"] }
    instance.utils = {
      getFilePath: () => "",
      isShown: el => !el.classList.contains("plugin-common-hidden"),
    }

    let renders = 0
    instance._renderStale = () => { renders++ }

    const classes = new Set()
    const viewStale = {
      classList: {
        add: name => classes.add(name),
        remove: name => classes.delete(name),
        contains: name => classes.has(name),
      },
    }
    instance.entities = { viewStale, panel: null }

    viewStale.classList.add("plugin-common-hidden")
    instance._render()
    assert.equal(renders, 0, "a hidden view must not be re-rendered")

    viewStale.classList.remove("plugin-common-hidden")
    instance._render()
    assert.equal(renders, 1)
  })
})

// ---- stale rows in the search results ---------------------------------------

test("a result row for a file already known to be gone is flagged and offers removal", async () => {
  await withFakeDocument(() => {
    const instance = createInstance()
    instance.repoDir = "/root/kb"
    instance.repo = { getFileTags: () => ["Git"] }
    instance.pathExists = new Map([["notes/gone.md", false], ["notes/a.md", true]])

    const gone = instance._buildFileRow({ filePath: "notes/gone.md", tags: ["Git"] })
    assert.equal(gone.classList.contains("tag-manager-file-missing"), true)
    // The tooltip keeps the path and adds the reason.
    assert.match(gone.title, /notes\/gone\.md/)
    assert.match(gone.title, /staleRowHint/)
    // Text block plus the remove control.
    assert.equal(gone.children.length, 2)
    assert.equal(gone.children[1].className, "tag-manager-file-remove")
    assert.equal(gone.children[1].title, "act.removeRecord")

    const live = instance._buildFileRow({ filePath: "notes/a.md", tags: ["Git"] })
    assert.equal(live.classList.contains("tag-manager-file-missing"), false)
    assert.equal(live.title, "notes/a.md")
  })
})

test("unchecked rows get one batched existence check and are flagged when gone", async () => {
  await withFakeDocument(async () => {
    const instance = createInstance()
    instance.repoDir = "/root/kb"
    instance.repo = { getFileTags: () => [] }
    instance.pathExists = new Map()
    instance.utils = {
      Package: { FsExtra: { pathExists: async absolute => !absolute.endsWith("dead.md") } },
    }

    const visible = [
      { filePath: "notes/live.md", tags: [] },
      { filePath: "notes/dead.md", tags: [] },
    ]
    const elements = new Map(visible.map(row => [row.filePath, instance._buildFileRow(row)]))
    assert.equal(elements.get("notes/dead.md").classList.contains("tag-manager-file-missing"), false)

    await instance._verifyVisibleRows(visible, elements)

    assert.equal(instance.pathExists.get("notes/live.md"), true)
    assert.equal(instance.pathExists.get("notes/dead.md"), false)
    assert.equal(elements.get("notes/live.md").classList.contains("tag-manager-file-missing"), false)
    assert.equal(elements.get("notes/dead.md").classList.contains("tag-manager-file-missing"), true)
  })
})

test("rows already cached are not re-checked on the next render", async () => {
  await withFakeDocument(async () => {
    const instance = createInstance()
    instance.repoDir = "/root/kb"
    instance.repo = { getFileTags: () => [] }
    instance.pathExists = new Map([["notes/a.md", true]])
    let calls = 0
    instance.utils = { Package: { FsExtra: { pathExists: async () => { calls++; return true } } } }

    const visible = [{ filePath: "notes/a.md", tags: [] }]
    await instance._verifyVisibleRows(visible, new Map())
    assert.equal(calls, 0, "a cached answer must not be re-statted")
  })
})

test("a scan seeds the existence cache for every indexed path", async () => {
  const instance = createInstance()
  instance.repoDir = "/root/kb"
  instance.repo = { filePaths: ["notes/a.md", "notes/gone.md"], findStale: () => ["notes/gone.md"] }
  instance._collectDiskPaths = async () => ["notes/a.md"]

  await instance._scan()

  assert.equal(instance.pathExists.get("notes/a.md"), true)
  assert.equal(instance.pathExists.get("notes/gone.md"), false)
  assert.deepEqual(instance.staleCache.stale, ["notes/gone.md"])
})

test("clicking a stale result warns instead of asking Typora to open a missing file", async () => {
  const instance = createInstance()
  instance.repoDir = "/root/kb"
  instance.pathExists = new Map()
  const notices = []
  instance.utils = {
    Package: { FsExtra: { pathExists: async () => false } },
    notification: { show: (message, type) => notices.push([message, type]) },
  }
  instance._render = () => undefined

  const previousFile = global.File
  let opened = 0
  global.File = { editor: { library: { openFile: () => { opened++ } } } }
  try {
    await instance._openFile("notes/gone.md")
  } finally {
    global.File = previousFile
  }

  assert.equal(opened, 0)
  assert.equal(notices.length, 1)
  assert.equal(notices[0][1], "warning")
  assert.match(notices[0][0], /staleRowHint/)
  assert.equal(instance.pathExists.get("notes/gone.md"), false)
})

test("clicking a live result opens it through Typora", async () => {
  const instance = createInstance()
  instance.repoDir = "/root/kb"
  instance.pathExists = new Map()
  instance.utils = { Package: { FsExtra: { pathExists: async () => true } } }

  const previousFile = global.File
  const opened = []
  global.File = { editor: { library: { openFile: absolute => opened.push(absolute) } } }
  try {
    await instance._openFile("notes/a.md")
  } finally {
    global.File = previousFile
  }

  assert.deepEqual(opened, [path.join("/root/kb", "notes", "a.md")])
})

test("forgetting a record clears its cached existence and its stale entry", async () => {
  const instance = createInstance()
  instance.repoDir = "/root/kb"
  instance.pathExists = new Map([["notes/gone.md", false]])
  instance.staleCache = { onDisk: [], stale: ["notes/gone.md"] }
  instance.repo = {
    deleteRecords: async () => ({ success: true, removed: [{ filePath: "notes/gone.md", tags: [] }] }),
  }
  const notices = []
  instance.utils = { notification: { show: (message, type) => notices.push([message, type]) } }
  instance._render = () => undefined
  instance._refreshTree = () => undefined

  await instance._forgetRecord("notes/gone.md")

  assert.equal(instance.pathExists.has("notes/gone.md"), false)
  assert.deepEqual(instance.staleCache.stale, [])
  assert.equal(notices.length, 1)
  assert.equal(notices[0][1], "success")
})
