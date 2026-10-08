const PATH = require("path")

const paths = require("./paths")
const { DEFAULT_INDEX_FILE, TagIndexStore } = require("./store")
const { TagRepository, REASON } = require("./repository")

const BADGE_CLASS = "plugin-tag-manager-badge"
const MAX_FILE_ROWS = 300

/**
 * Grace period before a removed tree row is turned into an index cleanup. A rename also
 * removes the old row, so the hook must not act on the same tick as the rename.
 */
const DELETE_RECONCILE_DELAY = 600

/**
 * Repository results are reason codes rather than prose, so the wording stays in the
 * locale files and the same code can be reused by a future server/CLI front end.
 */
const REASON_I18N = {
  [REASON.DUPLICATE]: "tagDuplicate",
  [REASON.NOT_FOUND]: "tagMissing",
  [REASON.EMPTY_TAG]: "tagEmpty",
  [REASON.TAG_TOO_LONG]: "tagTooLong",
  [REASON.TAG_INVALID]: "tagInvalid",
  [REASON.PATH_INVALID]: "pathInvalid",
  [REASON.CORRUPT_INDEX]: "indexCorrupt",
  [REASON.NO_REPOSITORY]: "noMountFolder",
  [REASON.WRITE_FAILED]: "writeFailed",
}

/**
 * File-level tag manager.
 *
 * The workspace (a folder of markdown notes) carries a sidecar JSON index at
 * `.kbdatabase/tags.json`; the markdown files themselves are never modified. Typora stays
 * the editor, so this plugin only owns the tag layer:
 *   - a panel to read/sync the index, add and remove tags, and search files by tag
 *   - a tag-count badge injected into Typora's own file tree
 */
class TagManagerPlugin extends BasePlugin {
  // The editor button is contributed to the shared `action_buttons` group through its
  // `BUTTONS` setting, so this plugin owns no editor-corner UI of its own.
  style = () => true

  html = () => `
    <div id="plugin-tag-manager" class="tag-manager-mask plugin-common-hidden">
      <div class="tag-manager-dialog" role="dialog" aria-modal="true" aria-labelledby="plugin-tag-manager-title">
        <div class="tag-manager-header">
          <div id="plugin-tag-manager-title" class="tag-manager-heading"></div>
          <div class="tag-manager-header-actions">
            <div class="tag-manager-button tag-manager-sync fa fa-refresh" role="button" tabindex="0"
                 title="${this.i18n.t("act.sync")}" aria-label="${this.i18n.t("act.sync")}"></div>
            <div class="tag-manager-button tag-manager-back fa fa-arrow-left plugin-common-hidden" role="button" tabindex="0"
                 title="${this.i18n.t("act.back")}" aria-label="${this.i18n.t("act.back")}"></div>
            <div class="tag-manager-button tag-manager-clean fa fa-trash plugin-common-hidden" role="button" tabindex="0"
                 title="${this.i18n.t("act.clean")}" aria-label="${this.i18n.t("act.clean")}"></div>
            <div class="tag-manager-button tag-manager-close ion-close-round" role="button" tabindex="0"
                 title="${this.i18n.t("act.close")}" aria-label="${this.i18n.t("act.close")}"></div>
          </div>
        </div>

        <div class="tag-manager-main">
          <div class="tag-manager-view tag-manager-view-doc">
            <div class="tag-manager-status"></div>

            <div class="tag-manager-section">
              <div class="tag-manager-label tag-manager-title-doc"></div>
              <div class="tag-manager-doc"></div>
              <div class="tag-manager-chips"></div>
              <div class="tag-manager-add-row">
                <input class="tag-manager-input" type="text" />
                <div class="tag-manager-add" role="button" tabindex="0"></div>
              </div>
              <div class="tag-manager-suggest"></div>
            </div>

            <div class="tag-manager-section">
              <div class="tag-manager-label tag-manager-title-tags"></div>
              <input class="tag-manager-search" type="search" />
              <div class="tag-manager-tags"></div>
            </div>

            <div class="tag-manager-section">
              <div class="tag-manager-label tag-manager-title-files"></div>
              <div class="tag-manager-files"></div>
            </div>
          </div>

          <div class="tag-manager-view tag-manager-view-stale plugin-common-hidden">
            <div class="tag-stale-summary"></div>
            <div class="tag-stale-list"></div>
          </div>
        </div>
      </div>
    </div>`

  hotkey = () => [{ hotkey: this.config.HOTKEY, callback: this.call }]

  repo = null
  repoDir = ""
  query = ""
  selectedTag = ""
  staleCache = null
  /** relative path -> whether it exists on disk. Filled by scans, renders and clicks. */
  pathExists = new Map()
  /** Absolute paths removed by a rename, so the delete hook can tell the two apart. */
  recentlyRenamed = new Map()
  /** relative path -> pending cleanup timer. */
  cleanupTimers = new Map()

  init() {
    const query = selector => document.querySelector(selector)
    this.entities = {
      panel: query("#plugin-tag-manager"),
      dialog: query("#plugin-tag-manager .tag-manager-dialog"),
      heading: query("#plugin-tag-manager .tag-manager-heading"),
      sync: query("#plugin-tag-manager .tag-manager-sync"),
      back: query("#plugin-tag-manager .tag-manager-back"),
      clean: query("#plugin-tag-manager .tag-manager-clean"),
      close: query("#plugin-tag-manager .tag-manager-close"),
      viewDoc: query("#plugin-tag-manager .tag-manager-view-doc"),
      viewStale: query("#plugin-tag-manager .tag-manager-view-stale"),
      status: query("#plugin-tag-manager .tag-manager-status"),
      titleDoc: query("#plugin-tag-manager .tag-manager-title-doc"),
      doc: query("#plugin-tag-manager .tag-manager-doc"),
      chips: query("#plugin-tag-manager .tag-manager-chips"),
      input: query("#plugin-tag-manager .tag-manager-input"),
      add: query("#plugin-tag-manager .tag-manager-add"),
      suggest: query("#plugin-tag-manager .tag-manager-suggest"),
      titleTags: query("#plugin-tag-manager .tag-manager-title-tags"),
      search: query("#plugin-tag-manager .tag-manager-search"),
      tags: query("#plugin-tag-manager .tag-manager-tags"),
      titleFiles: query("#plugin-tag-manager .tag-manager-title-files"),
      files: query("#plugin-tag-manager .tag-manager-files"),
      staleSummary: query("#plugin-tag-manager .tag-stale-summary"),
      staleList: query("#plugin-tag-manager .tag-stale-list"),
    }

    if (this.entities.panel) {
      this.entities.titleDoc.textContent = this.i18n.t("title.currentDocument")
      this.entities.titleTags.textContent = this.i18n.t("title.browse")
      this.entities.titleFiles.textContent = this.i18n.t("title.files")
      this.entities.input.placeholder = this.i18n.t("placeholder.tag")
      this.entities.search.placeholder = this.i18n.t("placeholder.search")
      this.entities.add.textContent = this.i18n.t("act.add")
      this._showManagerView()
    }
  }

  process() {
    if (this.entities.panel) {
      this._wirePanel()
      this._wireInputs()
    }
    this._decorateFileTree()
    this._watchDeletions()
    this._watchRename()
    this._wireEvents()
    this._ensureLoaded().then(() => this._render())
  }

  call = () => {
    if (!this.entities.panel) return
    if (this.utils.isShown(this.entities.panel)) {
      this.utils.hide(this.entities.panel)
      return
    }
    // Always reopen on the tag view, never on whatever the stale view was showing.
    this._showManagerView()
    this._ensureLoaded().then(() => {
      this._render()
      this.utils.show(this.entities.panel)
      this.entities.input.focus()
    })
  }

  // ---- dialog shell ---------------------------------------------------------

  _showManagerView() {
    if (!this.entities.panel) return
    this.entities.heading.textContent = this.pluginName
    this.utils.show(this.entities.viewDoc)
    this.utils.hide(this.entities.viewStale)
    this.utils.show(this.entities.sync)
    this.utils.hide(this.entities.back)
    this.utils.hide(this.entities.clean)
  }

  async _showStaleView({ rescan = true } = {}) {
    if (!this.entities.panel || !this.repo) return
    this.entities.heading.textContent = this.i18n.t("title.staleRecords")
    this.utils.hide(this.entities.viewDoc)
    this.utils.show(this.entities.viewStale)
    this.utils.hide(this.entities.sync)
    this.utils.show(this.entities.back)
    this.utils.show(this.entities.clean)

    if (rescan || !this.staleCache) {
      try {
        await this.utils.runWithFakeProgressBar(() => this._scan(), 60000)
      } catch (err) {
        this.utils.notification.show(this.i18n.t("loadFailed", { error: String(err && err.message || err) }), "error")
        return
      }
    }
    this._renderStale()
    this.utils.show(this.entities.panel)
  }

  // ---- wiring ---------------------------------------------------------------

  _wirePanel() {
    this.entities.close.addEventListener("click", () => this.utils.hide(this.entities.panel))
    this.entities.sync.addEventListener("click", () => this._sync())
    this.entities.back.addEventListener("click", () => {
      this._showManagerView()
      this._render()
    })
    this.entities.clean.addEventListener("click", () => this._cleanAllStale())

    // The mask swallows clicks meant for the editor; Escape closes, as in repository.
    document.addEventListener("keydown", ev => {
      if (ev.key === "Escape" && this.utils.isShown(this.entities.panel)) {
        this.utils.hide(this.entities.panel)
      }
    })

    this.entities.add.addEventListener("click", () => this._addTag())
    this.entities.add.addEventListener("keydown", ev => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault()
        this._addTag()
      }
    })
  }

  _wireInputs() {
    // AGENTS.md: live text inputs must go through createSmartInputHandler so IME composition
    // (Chinese input) does not fire a query per keystroke. `caseSensitive` keeps the tag
    // spelling the user typed, which the handler would otherwise lowercase.
    this.utils.createSmartInputHandler(
      this.entities.input,
      value => this._renderSuggestions(value),
      { caseSensitive: true },
    )
    this.entities.input.addEventListener("keydown", ev => {
      if (ev.key === "Enter") {
        ev.preventDefault()
        this._addTag()
      } else if (ev.key === "Escape") {
        this.entities.input.value = ""
        this._renderSuggestions("")
      }
    })

    this._searchHandler = this.utils.createSmartInputHandler(
      this.entities.search,
      value => {
        this.query = value
        this.selectedTag = ""
        this._render()
      },
      { caseSensitive: true },
    )
    this.entities.search.addEventListener("keydown", ev => {
      if (ev.key === "Enter") {
        ev.preventDefault()
        this._selectExactTag(this.entities.search.value)
      } else if (ev.key === "Escape") {
        this.entities.search.value = ""
        this.query = ""
        this.selectedTag = ""
        this._render()
      }
    })
  }

  _wireEvents() {
    const { eventHub } = this.utils
    const onFolderMaybeChanged = () => this._ensureLoaded().then(() => this._render())
    eventHub.on(eventHub.eventType.allPluginsHadInjected, onFolderMaybeChanged)
    eventHub.on(eventHub.eventType.fileOpened, onFolderMaybeChanged)
    eventHub.on(eventHub.eventType.otherFileOpened, onFolderMaybeChanged)
    eventHub.on(eventHub.eventType.fileContentLoaded, () => this._render())
  }

  _watchRename() {
    // Typora rebroadcasts its own renames over IPC; it is the only rename signal that
    // covers the file tree, and window_tab uses the same channel.
    try {
      if (typeof reqnode !== "function") return
      reqnode("electron").ipcRenderer.on("didRename", (sender, payload) => {
        const { oldPath, newPath } = payload || {}
        if (oldPath && newPath) this._onRenamed(oldPath, newPath)
      })
    } catch (err) {
      console.warn("[tagora] rename hook unavailable:", err)
    }
  }

  /**
   * Typora only broadcasts `didRename` over IPC — there is no delete channel — so the file
   * tree's own `removeFileOrFolder(path)` is decorated instead. It takes a plain path and
   * fires both for a delete performed in Typora and for a removal Typora detects on disk.
   * A rename removes the old row through the same method, which is why cleanup is deferred
   * and cross-checked against `recentlyRenamed`.
   */
  _watchDeletions() {
    const promise = this.utils.decorator.afterCall(
      () => this._findFileTreeOwner(),
      "removeFileOrFolder",
      (result, absolutePath) => this._onTreeRowRemoved(absolutePath),
    )
    if (promise && typeof promise.catch === "function") {
      promise.catch(err => console.warn("[tagora] delete hook unavailable:", err))
    }
  }

  /** The tree object has no single stable path, so probe the shapes it is reachable by. */
  _findFileTreeOwner() {
    const candidates = [
      File?.editor?.library?.fileTree,
      File?.editor?.library,
      File?.editor?.library?.fileTree?.parent,
    ]
    return candidates.find(obj => obj && typeof obj.removeFileOrFolder === "function")
  }

  _hasRecordsUnder(relative) {
    const prefix = `${relative.toLowerCase()}/`
    return this.repo.filePaths.some(filePath => filePath.toLowerCase().startsWith(prefix))
  }

  _onTreeRowRemoved(absolutePath) {
    if (typeof absolutePath !== "string" || !absolutePath) return
    if (!this.repo || !this.repoDir) return
    // A rename removes the old row too; didRename owns that case.
    if (this.recentlyRenamed.has(absolutePath)) return

    const relative = paths.relativeFrom(this.repoDir, absolutePath)
    if (!relative) return
    if (!this.repo.hasFile(relative) && !this._hasRecordsUnder(relative)) return

    this._scheduleRowCleanup(relative, absolutePath)
  }

  /**
   * Wait out the grace period, then drop records only if the path really is gone from disk.
   * A cancelled delete dialog, an undo, or a rename therefore all leave the index alone.
   */
  _scheduleRowCleanup(relative, absolutePath) {
    const pending = this.cleanupTimers.get(relative)
    if (pending) clearTimeout(pending)

    const timer = setTimeout(async () => {
      this.cleanupTimers.delete(relative)
      try {
        if (this.recentlyRenamed.has(absolutePath)) return
        if (!this.repo) return
        if (!this.repo.hasFile(relative) && !this._hasRecordsUnder(relative)) return

        const stillThere = await this.utils.Package.FsExtra.pathExists(absolutePath)
        if (stillThere) return

        const result = await this.repo.deleteRecords(relative)
        if (result.success) {
          this._render()
          this._refreshTree()
        }
      } catch (err) {
        console.warn("[tagora] index cleanup failed:", err)
      }
    }, DELETE_RECONCILE_DELAY)

    this.cleanupTimers.set(relative, timer)
  }

  _decorateFileTree() {
    if (!this.config.SHOW_TREE_BADGE) return
    const promise = this.utils.decorator.afterCall(
      () => File?.editor?.library?.fileTree,
      "renderNode",
      ($node, info) => this._decorateNode($node, info),
    )
    if (promise && typeof promise.then === "function") {
      // Rows rendered before the decoration was installed have no badge yet, so redraw once.
      promise
        .then(() => this._refreshTree())
        .catch(err => console.warn("[tagora] file tree decorate failed:", err))
    }
  }

  /** Append (or remove) the tag-count badge on one row of Typora's file tree. */
  _decorateNode($node, info) {
    try {
      if (!info || !info.isFile || !$node) return
      const element = typeof $node.get === "function" ? $node.get(0) : $node
      if (!element || typeof element.querySelector !== "function") return

      const content = element.querySelector(":scope > .file-node-content") || element
      if (!content) return

      const existing = content.querySelector(`.${BADGE_CLASS}`)
      const count = this._tagCountForTreePath(element.dataset ? element.dataset.path : "")
      if (!count) {
        if (existing) existing.remove()
        return
      }

      const badge = existing || document.createElement("div")
      badge.className = BADGE_CLASS
      badge.textContent = String(count)
      badge.title = this.i18n.t("badgeHint", { count })
      if (!existing) content.appendChild(badge)
    } catch (err) {
      console.warn("[tagora] badge failed:", err)
    }
  }

  _tagCountForTreePath(absolutePath) {
    if (!this.repo || !absolutePath || !this.repoDir) return 0
    const relative = paths.relativeFrom(this.repoDir, absolutePath)
    if (!relative) return 0
    return this.repo.getFileTags(relative).length
  }

  // ---- index lifecycle ------------------------------------------------------

  /** Load (or reload) the index whenever the mounted folder differs from the loaded one. */
  async _ensureLoaded() {
    const dir = this.utils.getMountFolder() || ""
    if (this.repo && dir === this.repoDir) return

    this.repoDir = dir
    this.repo = null
    this.selectedTag = ""
    this.staleCache = null
    this.pathExists.clear()
    if (!dir) return

    try {
      const store = new TagIndexStore({
        repoDir: dir,
        indexFile: this.config.INDEX_FILE || DEFAULT_INDEX_FILE,
      })
      const repo = new TagRepository({ store })
      await repo.load()
      this.repo = repo
      this._refreshTree()
    } catch (err) {
      console.error("[tagora] failed to load index:", err)
      this.utils.notification.show(this.i18n.t("loadFailed", { error: String(err && err.message || err) }), "error")
    }
  }

  /** Typora re-renders the file tree from scratch, which drops our badges. */
  _refreshTree() {
    try {
      File?.editor?.library?.refreshPanelCommand?.()
    } catch (err) {
      console.warn("[tagora] tree refresh failed:", err)
    }
  }

  // ---- actions --------------------------------------------------------------

  _currentFilePath() {
    const absolute = this.utils.getFilePath()
    if (!absolute || !this.repoDir) return ""
    return paths.relativeFrom(this.repoDir, absolute)
  }

  async _addTag() {
    const tagName = this.entities.input.value
    const relative = this._currentFilePath()

    if (!this.repo) {
      this.utils.notification.show(this.i18n.t("noMountFolder"), "warning")
      return
    }
    if (!relative) {
      this.utils.notification.show(this.i18n.t("noDocument"), "warning")
      return
    }

    const result = await this.repo.addTag(relative, tagName)
    if (result.success) {
      this.entities.input.value = ""
      this.entities.suggest.textContent = ""
      this.utils.notification.show(this.i18n.t("tagAdded", { tag: result.tagName }), "success")
    } else {
      this.utils.notification.show(this._reasonText(result), "warning")
    }
    this._render()
  }

  async _removeTag(tagName) {
    const relative = this._currentFilePath()
    if (!this.repo || !relative) return
    const result = await this.repo.removeTag(relative, tagName)
    if (result.success) {
      this.utils.notification.show(this.i18n.t("tagRemoved", { tag: result.tagName }), "success")
    } else {
      this.utils.notification.show(this._reasonText(result), "warning")
    }
    this._render()
  }

  /**
   * Reconcile the index with the real directory.
   * The scan removes nothing by itself: stale records are shown in their own window and
   * dropped only on an explicit action there.
   */
  async _sync() {
    if (!this.repo) {
      this.utils.notification.show(this.i18n.t("noMountFolder"), "warning")
      return
    }

    if (this.repo.readOnly) {
      await this._offerReset()
      return
    }

    try {
      await this.utils.runWithFakeProgressBar(() => this._scan(), 60000)
    } catch (err) {
      this.utils.notification.show(this.i18n.t("loadFailed", { error: String(err && err.message || err) }), "error")
      return
    }

    const stale = this.staleCache ? this.staleCache.stale : []
    if (!stale.length) {
      this.utils.notification.show(this.i18n.t("syncClean", { files: this.staleCache.onDisk.length }), "success")
      return
    }

    this.utils.notification.show(this.i18n.t("staleSummary", { count: stale.length }), "warning")
    await this._showStaleView({ rescan: false })
  }

  // ---- stale records --------------------------------------------------------

  /** One scan, shared by the sync action and the stale window. */
  async _scan() {
    const onDisk = await this._collectDiskPaths()
    const stale = this.repo ? this.repo.findStale(onDisk) : []
    this.staleCache = { onDisk, stale }

    // The scan already knows the answer for every indexed path, so remember it and save the
    // file list a round of existence checks.
    const found = new Set(onDisk.map(filePath => filePath.toLowerCase()))
    if (this.repo) {
      this.repo.filePaths.forEach(filePath => this.pathExists.set(filePath, found.has(filePath.toLowerCase())))
    }
    return this.staleCache
  }

  _renderStale() {
    const list = this.entities.staleList
    if (!list || !this.entities.staleSummary) return

    list.textContent = ""
    const stale = (this.staleCache && this.staleCache.stale) || []
    this.entities.staleSummary.textContent = stale.length
      ? this.i18n.t("staleSummary", { count: stale.length })
      : this.i18n.t("staleNone")

    if (!stale.length) {
      list.appendChild(this._buildEmpty("staleNone"))
      return
    }
    stale.forEach(relative => list.appendChild(this._buildStaleRow(relative)))
  }

  _buildStaleRow(relative) {
    const row = document.createElement("div")
    row.className = "tag-stale-row"

    const name = document.createElement("div")
    name.className = "tag-stale-name"
    name.textContent = relative
    name.title = relative
    row.appendChild(name)

    const tags = document.createElement("div")
    tags.className = "tag-stale-tags"
    tags.textContent = this.repo.getFileTags(relative).join(" · ") || "—"
    tags.title = tags.textContent
    row.appendChild(tags)

    const remove = document.createElement("div")
    remove.className = "tag-stale-remove"
    remove.textContent = "×"
    remove.title = this.i18n.t("act.removeRecord")
    remove.addEventListener("click", () => this._removeStaleRecord(relative))
    row.appendChild(remove)

    return row
  }

  async _removeStaleRecord(relative) {
    return this._forgetRecord(relative)
  }

  /** Drop a record from the index. Shared by the file list and the stale window. */
  async _forgetRecord(relativePath) {
    if (!this.repo) return

    const result = await this.repo.deleteRecords(relativePath)
    if (result.success) {
      this.pathExists.delete(relativePath)
      if (this.staleCache) {
        this.staleCache.stale = this.staleCache.stale.filter(filePath => filePath !== relativePath)
      }
      this.utils.notification.show(this.i18n.t("staleCleaned", { count: result.removed.length }), "success")
    } else {
      this.utils.notification.show(this._reasonText(result), "warning")
    }

    // _render() also refreshes the stale window when it is open.
    this._render()
    this._refreshTree()
  }

  async _cleanAllStale() {
    if (!this.repo) return

    const stale = (this.staleCache && this.staleCache.stale) || []
    if (!stale.length) {
      this.utils.notification.show(this.i18n.t("staleNone"), "info")
      return
    }

    const { response } = await this.utils.showMessageBox({
      type: "warning",
      title: this.pluginName,
      message: this.i18n.t("staleConfirm", { count: stale.length }),
      detail: stale.slice(0, 20).join("\n") + (stale.length > 20 ? "\n…" : ""),
      buttons: [this.i18n.t("act.clean"), this.i18n.t("act.cancel")],
      defaultId: 1,
      cancelId: 1,
    })
    if (response !== 0) return

    const pruned = await this.repo.pruneStale(this.staleCache.onDisk)
    if (pruned.success) {
      this.utils.notification.show(this.i18n.t("staleCleaned", { count: pruned.removed.length }), "success")
      this.staleCache.stale = []
    } else {
      this.utils.notification.show(this._reasonText(pruned), "warning")
    }
    this._renderStale()
    this._render()
    this._refreshTree()
  }

  /** Recovery path for an unparseable index. Never runs without an explicit confirmation. */
  async _offerReset() {
    const { response } = await this.utils.showMessageBox({
      type: "warning",
      title: this.pluginName,
      message: this.i18n.t("indexCorrupt"),
      detail: (this.repo.issues || []).join("\n"),
      buttons: [this.i18n.t("act.reset"), this.i18n.t("act.cancel")],
      defaultId: 1,
      cancelId: 1,
    })
    if (response !== 0) return

    const result = await this.repo.reset()
    if (result.success) this.utils.notification.show(this.i18n.t("indexReset"), "success")
    else this.utils.notification.show(this._reasonText(result), "warning")
    this._render()
    this._refreshTree()
  }

  async _onRenamed(oldAbsolute, newAbsolute) {
    if (!this.repo || !this.repoDir) return
    if (!this.utils.getMountFolder()) return

    // Mark first: the tree drops the old row through the very hook the delete cleanup
    // listens on, and that may arrive before this handler runs.
    this._markRenamed(oldAbsolute)

    const from = paths.relativeFrom(this.repoDir, oldAbsolute)
    const to = paths.relativeFrom(this.repoDir, newAbsolute)
    if (!from || !to) return

    const result = await this.repo.renameFile(from, to)
    if (result.success && !result.unchanged) {
      this._render()
      this._refreshTree()
    }
  }

  /** Remember a rename source so the delete cleanup leaves it alone. */
  _markRenamed(absolutePath) {
    if (!absolutePath) return
    this.recentlyRenamed.set(absolutePath, Date.now())

    const cutoff = Date.now() - 10000
    this.recentlyRenamed.forEach((at, key) => {
      if (at < cutoff) this.recentlyRenamed.delete(key)
    })
  }

  _selectExactTag(query) {
    if (!this.repo) return
    const needle = paths.tagKey(query)
    if (!needle) return
    const match = this.repo.tagsWithCounts().find(entry => paths.tagKey(entry.tagName) === needle)
    if (match) {
      this.selectedTag = match.tagName
      this.query = match.tagName
      this.entities.search.value = match.tagName
      this._render()
    }
  }

  async _collectDiskPaths() {
    const dir = this.repoDir
    const extensions = paths.normalizeExtensions(this.config.MARKDOWN_EXT)
    const excluded = (Array.isArray(this.config.EXCLUDE_DIRS) && this.config.EXCLUDE_DIRS.length)
      ? this.config.EXCLUDE_DIRS
      : paths.DEFAULT_EXCLUDE_DIRS
    const excludedSet = new Set(excluded.map(name => String(name).toLowerCase()))

    const found = []
    await this.utils.walkDir({
      dir,
      dirFilter: name => !excludedSet.has(String(name).toLowerCase()),
      fileFilter: name => !paths.isHiddenName(name) && paths.hasAllowedExtension(name, extensions),
      onFile: ({ path }) => {
        const relative = paths.relativeFrom(dir, path)
        if (relative) found.push(relative)
      },
      onNonFatalError: (path, err) => console.warn("[tagora] scan skipped", path, err),
    })
    return found
  }

  // ---- rendering ------------------------------------------------------------

  _reasonText(result) {
    const key = REASON_I18N[result && result.reason] || "actionFailed"
    const error = result && result.error
    return this.i18n.t(key, { error: error ? String(error.message || error) : "" })
  }

  _render() {
    if (!this.entities) return
    if (this.entities.panel) {
      this._renderStatus()
      this._renderTagList()
      this._renderFileList()
    }
    // The document section is refreshed by every mutation.
    this._renderDocument()
    // Keep an open stale view in step with tag edits made elsewhere.
    if (this.entities.viewStale && this.utils.isShown(this.entities.viewStale) && this.staleCache) this._renderStale()
  }

  _renderStatus() {
    const el = this.entities.status
    el.textContent = ""
    if (!this.repoDir) {
      el.textContent = this.i18n.t("noMountFolder")
      el.classList.add("tag-manager-status-warn")
      return
    }
    el.classList.remove("tag-manager-status-warn")

    const summary = this.repo
      ? this.i18n.t("summary", { files: this.repo.fileCount, tags: this.repo.tagCount })
      : this.i18n.t("loading")
    const line = document.createElement("div")
    line.textContent = summary
    el.appendChild(line)

    const where = document.createElement("div")
    where.className = "tag-manager-path"
    where.textContent = this.repoDir
    where.title = this.repoDir
    el.appendChild(where)

    const stale = document.createElement("div")
    stale.className = "tag-manager-stale-link"
    stale.textContent = this.i18n.t("act.viewStale")
    stale.addEventListener("click", () => this._showStaleView())
    el.appendChild(stale)
  }

  _currentTags() {
    const relative = this._currentFilePath()
    if (!this.repo || !relative) return { relative: "", tags: [] }
    return { relative, tags: this.repo.getFileTags(relative) }
  }

  _renderDocument() {
    const { relative, tags } = this._currentTags()

    if (this.entities.doc) this.entities.doc.textContent = relative || this.i18n.t("noDocument")
    if (this.entities.chips) this._renderChips(this.entities.chips, tags, "tag-manager-empty")
  }

  _renderChips(container, tags, emptyClass) {
    container.textContent = ""
    if (!tags.length) {
      const empty = document.createElement("div")
      empty.className = emptyClass
      empty.textContent = this.i18n.t("noTags")
      container.appendChild(empty)
      return
    }
    tags.forEach(tagName => container.appendChild(this._buildChip(tagName)))
  }

  // ---- editor button --------------------------------------------------------

  _buildChip(tagName) {
    const chip = document.createElement("div")
    chip.className = "tag-manager-chip"

    const label = document.createElement("div")
    label.className = "tag-manager-chip-label"
    label.textContent = tagName
    label.title = tagName
    chip.appendChild(label)

    const remove = document.createElement("div")
    remove.className = "tag-manager-chip-remove"
    remove.textContent = "×"
    remove.title = this.i18n.t("act.removeTag")
    remove.addEventListener("click", () => this._removeTag(tagName))
    chip.appendChild(remove)

    return chip
  }

  _renderSuggestions(query) {
    const list = this.entities.suggest
    if (!list) return
    list.textContent = ""
    if (!this.repo) return

    const owned = this._currentTags().tags
    const limit = Number(this.config.SUGGESTION_LIMIT) > 0 ? Number(this.config.SUGGESTION_LIMIT) : 10
    const candidates = this.repo.suggestTags(query, { exclude: owned, limit })
    if (!candidates.length) return

    candidates.forEach(candidate => {
      const row = document.createElement("div")
      row.className = "tag-manager-suggest-row"

      const name = document.createElement("div")
      name.className = "tag-manager-suggest-name"
      name.textContent = candidate.tagName
      row.appendChild(name)

      const count = document.createElement("div")
      count.className = "tag-manager-count"
      count.textContent = String(candidate.fileCount)
      row.appendChild(count)

      row.addEventListener("click", () => {
        this.entities.input.value = candidate.tagName
        list.textContent = ""
        this._addTag()
      })
      list.appendChild(row)
    })
  }

  _renderTagList() {
    const list = this.entities.tags
    list.textContent = ""
    if (!this.repo) return

    const entries = this.repo.tagsWithCounts()
    const needle = paths.tagKey(this.query)
    const visible = needle
      ? entries.filter(entry => paths.tagKey(entry.tagName).includes(needle))
      : entries

    if (!visible.length) {
      list.appendChild(this._buildEmpty(entries.length ? "noMatch" : "noTags"))
      return
    }

    visible.slice(0, MAX_FILE_ROWS).forEach(entry => {
      const row = document.createElement("div")
      row.className = "tag-manager-tag-row"
      if (this.selectedTag && paths.tagKey(this.selectedTag) === paths.tagKey(entry.tagName)) {
        row.classList.add("tag-manager-selected")
      }

      const name = document.createElement("div")
      name.className = "tag-manager-tag-name"
      name.textContent = entry.tagName
      name.title = entry.tagName
      row.appendChild(name)

      const count = document.createElement("div")
      count.className = "tag-manager-count"
      count.textContent = String(entry.fileCount)
      row.appendChild(count)

      row.addEventListener("click", () => {
        const same = this.selectedTag && paths.tagKey(this.selectedTag) === paths.tagKey(entry.tagName)
        this.selectedTag = same ? "" : entry.tagName
        this.query = same ? "" : entry.tagName
        this.entities.search.value = this.query
        this._render()
      })
      list.appendChild(row)
    })
  }

  _renderFileList() {
    const list = this.entities.files
    list.textContent = ""
    if (!this.repo) return

    let rows
    if (this.selectedTag) {
      rows = this.repo.searchByTag(this.selectedTag)
    } else if (this.query) {
      const needle = paths.tagKey(this.query)
      rows = this.repo.listFiles().filter(row => row.tags.some(tag => paths.tagKey(tag).includes(needle)))
    } else {
      rows = this.repo.listFiles()
    }

    if (!rows.length) {
      list.appendChild(this._buildEmpty(this.repo.fileCount ? "noMatch" : "noFiles"))
      return
    }

    const visible = rows.slice(0, MAX_FILE_ROWS)
    const elements = new Map()
    visible.forEach(row => {
      const el = this._buildFileRow(row)
      elements.set(row.filePath, el)
      list.appendChild(el)
    })

    if (rows.length > visible.length) {
      const more = document.createElement("div")
      more.className = "tag-manager-empty"
      more.textContent = this.i18n.t("moreRows", { count: rows.length - visible.length })
      list.appendChild(more)
    }

    this._verifyVisibleRows(visible, elements)
  }

  _buildFileRow(row) {
    const el = document.createElement("div")
    el.className = "tag-manager-file-row"
    el.title = row.filePath

    const main = document.createElement("div")
    main.className = "tag-manager-file-main"

    const name = document.createElement("div")
    name.className = "tag-manager-file-name"
    name.textContent = paths.basename(row.filePath)
    main.appendChild(name)

    const dir = document.createElement("div")
    dir.className = "tag-manager-file-dir"
    dir.textContent = paths.dirname(row.filePath) || "."
    main.appendChild(dir)

    const tags = document.createElement("div")
    tags.className = "tag-manager-file-tags"
    tags.textContent = row.tags.join(" · ")
    main.appendChild(tags)

    el.appendChild(main)

    const remove = document.createElement("div")
    remove.className = "tag-manager-file-remove"
    remove.textContent = "×"
    remove.title = this.i18n.t("act.removeRecord")
    remove.addEventListener("click", ev => {
      ev.stopPropagation()
      this._forgetRecord(row.filePath)
    })
    el.appendChild(remove)

    if (this.pathExists.get(row.filePath) === false) this._markRowMissing(el, row.filePath)
    el.addEventListener("click", () => this._openFile(row.filePath))
    return el
  }

  /**
   * A record can outlive its file, so a result row must not present itself as a live link.
   * Rows are flagged straight from the cache when a scan has already answered for them;
   * otherwise one batched round of existence checks fills the cache for the visible rows.
   */
  async _verifyVisibleRows(visible, elements) {
    const unknown = visible.filter(row => !this.pathExists.has(row.filePath))
    if (!unknown.length) return

    const checks = await Promise.all(unknown.map(async row => ({
      row,
      exists: await this.utils.Package.FsExtra.pathExists(PATH.join(this.repoDir, row.filePath)),
    })))

    checks.forEach(({ row, exists }) => {
      this.pathExists.set(row.filePath, exists)
      if (exists) return
      const el = elements.get(row.filePath)
      if (el) this._markRowMissing(el, row.filePath)
    })
  }

  _markRowMissing(el, filePath) {
    el.classList.add("tag-manager-file-missing")
    el.title = `${filePath}\n${this.i18n.t("staleRowHint")}`
  }

  _buildEmpty(key) {
    const empty = document.createElement("div")
    empty.className = "tag-manager-empty"
    empty.textContent = this.i18n.t(key)
    return empty
  }

  async _openFile(relativePath) {
    if (!this.repoDir) return
    const absolute = PATH.join(this.repoDir, relativePath)

    // Opening a path that is not there would make Typora ask to create it.
    if (!(await this._pathExists(relativePath, absolute))) {
      this.utils.notification.show(this.i18n.t("staleRowHint"), "warning")
      this._render()
      return
    }

    try {
      File?.editor?.library?.openFile(absolute)
    } catch (err) {
      console.warn("[tagora] openFile failed:", err)
      this.utils.notification.show(this.i18n.t("actionFailed", { error: String(err) }), "error")
    }
  }

  /** Cached existence check: only the first caller for a path pays for the `stat`. */
  async _pathExists(relativePath, absolutePath) {
    if (this.pathExists.has(relativePath)) return this.pathExists.get(relativePath)
    const exists = await this.utils.Package.FsExtra.pathExists(absolutePath)
    this.pathExists.set(relativePath, exists)
    return exists
  }
}

module.exports = {
  plugin: TagManagerPlugin,
}
