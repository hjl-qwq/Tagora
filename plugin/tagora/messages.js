/**
 * Built-in UI messages.
 *
 * Why this lives inside the plugin instead of `plugin/global/locales/*.json`:
 * Tagora is installed as a third-party plugin by the installer, and the installer's
 * contract is that a plugin package only ever owns files under `plugin/<id>/`. The shared
 * locale directory belongs to the plugin system and is overwritten by whole-package
 * updates, so a third-party plugin cannot own a namespace there.
 *
 * `bindMessages()` wraps the framework i18n object that every plugin receives, so all the
 * existing `this.i18n.t(...)` call sites keep working untouched, while the text now comes
 * from this table. The requested locale still comes from the framework (`auto` / `en` /
 * `zh-CN` / `zh-TW`), and anything missing here falls through to the framework lookup.
 *
 * Placeholders use the same `{{name}}` syntax as the framework.
 */

const LOCALES = ["en", "zh-CN", "zh-TW"]
const FALLBACK_LOCALE = "en"

const EN = {
  pluginName: "Tagora",

  "act.add": "Add",
  "act.back": "Back",
  "act.cancel": "Cancel",
  "act.clean": "Clean up",
  "act.close": "Close",
  "act.removeRecord": "Remove record",
  "act.removeTag": "Remove tag",
  "act.reset": "Reset index",
  "act.sync": "Sync",
  "act.viewStale": "View stale records",

  "title.currentDocument": "Current document",
  "title.browse": "Browse by tag",
  "title.files": "Files",
  "title.staleRecords": "Stale records",

  "placeholder.tag": "Type a tag, then press Enter",
  "placeholder.search": "Search tags or files",

  loading: "Loading…",
  summary: "{{files}} file(s) · {{tags}} tag(s)",
  noMountFolder: "Open a folder first",
  noDocument: "No document is open",
  noTags: "No tags yet",
  noFiles: "No files yet",
  noMatch: "No matches",
  moreRows: "{{count}} more not shown",
  badgeHint: "{{count}} tag(s)",

  tagAdded: "Added tag \"{{tag}}\"",
  tagRemoved: "Removed tag \"{{tag}}\"",
  tagDuplicate: "That tag already exists",
  tagMissing: "Tag not found",
  tagEmpty: "A tag cannot be empty",
  tagTooLong: "The tag is too long",
  tagInvalid: "The tag contains unsupported characters",
  pathInvalid: "Invalid file path",

  syncClean: "Sync complete, no stale record ({{files}} file(s) scanned)",
  staleSummary: "{{count}} record(s) point to files that no longer exist",
  staleNone: "No stale records",
  staleRowHint: "The file no longer exists; the record is kept",
  staleConfirm: "Delete {{count}} stale record(s)?",
  staleCleaned: "Cleaned {{count}} record(s)",

  indexCorrupt: "The tag index cannot be parsed and has to be reset",
  indexReset: "Tag index reset",
  loadFailed: "Failed to load the index: {{error}}",
  writeFailed: "Failed to write the index: {{error}}",
  actionFailed: "Action failed: {{error}}",
}

const ZH_CN = {
  pluginName: "标签管理",

  "act.add": "添加",
  "act.back": "返回",
  "act.cancel": "取消",
  "act.clean": "清理",
  "act.close": "关闭",
  "act.removeRecord": "移除记录",
  "act.removeTag": "移除标签",
  "act.reset": "重置索引",
  "act.sync": "同步",
  "act.viewStale": "查看失效记录",

  "title.currentDocument": "当前文档",
  "title.browse": "按标签浏览",
  "title.files": "文件",
  "title.staleRecords": "失效记录",

  "placeholder.tag": "输入标签后按回车",
  "placeholder.search": "搜索标签或文件",

  loading: "加载中…",
  summary: "{{files}} 个文件 · {{tags}} 个标签",
  noMountFolder: "请先打开一个文件夹",
  noDocument: "当前没有打开的文档",
  noTags: "还没有标签",
  noFiles: "还没有文件",
  noMatch: "没有匹配项",
  moreRows: "另有 {{count}} 条未显示",
  badgeHint: "{{count}} 个标签",

  tagAdded: "已添加标签「{{tag}}」",
  tagRemoved: "已移除标签「{{tag}}」",
  tagDuplicate: "该标签已存在",
  tagMissing: "找不到该标签",
  tagEmpty: "标签不能为空",
  tagTooLong: "标签过长",
  tagInvalid: "标签包含不支持的字符",
  pathInvalid: "文件路径无效",

  syncClean: "同步完成，未发现失效记录（已扫描 {{files}} 个文件）",
  staleSummary: "{{count}} 条记录对应的文件已不存在",
  staleNone: "没有失效记录",
  staleRowHint: "该文件已不存在，记录仍保留",
  staleConfirm: "将删除 {{count}} 条失效记录，确定吗？",
  staleCleaned: "已清理 {{count}} 条记录",

  indexCorrupt: "标签索引无法解析，需要重置",
  indexReset: "已重置标签索引",
  loadFailed: "加载索引失败：{{error}}",
  writeFailed: "写入索引失败：{{error}}",
  actionFailed: "操作失败：{{error}}",
}

const ZH_TW = {
  pluginName: "標籤管理",

  "act.add": "新增",
  "act.back": "返回",
  "act.cancel": "取消",
  "act.clean": "清理",
  "act.close": "關閉",
  "act.removeRecord": "移除記錄",
  "act.removeTag": "移除標籤",
  "act.reset": "重設索引",
  "act.sync": "同步",
  "act.viewStale": "檢視失效記錄",

  "title.currentDocument": "目前文件",
  "title.browse": "依標籤瀏覽",
  "title.files": "檔案",
  "title.staleRecords": "失效記錄",

  "placeholder.tag": "輸入標籤後按 Enter",
  "placeholder.search": "搜尋標籤或檔案",

  loading: "載入中…",
  summary: "{{files}} 個檔案 · {{tags}} 個標籤",
  noMountFolder: "請先開啟一個資料夾",
  noDocument: "目前沒有開啟的文件",
  noTags: "還沒有標籤",
  noFiles: "還沒有檔案",
  noMatch: "沒有符合的項目",
  moreRows: "另有 {{count}} 筆未顯示",
  badgeHint: "{{count}} 個標籤",

  tagAdded: "已新增標籤「{{tag}}」",
  tagRemoved: "已移除標籤「{{tag}}」",
  tagDuplicate: "該標籤已存在",
  tagMissing: "找不到該標籤",
  tagEmpty: "標籤不能為空",
  tagTooLong: "標籤過長",
  tagInvalid: "標籤包含不支援的字元",
  pathInvalid: "檔案路徑無效",

  syncClean: "同步完成，未發現失效記錄（已掃描 {{files}} 個檔案）",
  staleSummary: "{{count}} 筆記錄對應的檔案已不存在",
  staleNone: "沒有失效記錄",
  staleRowHint: "該檔案已不存在，記錄仍保留",
  staleConfirm: "將刪除 {{count}} 筆失效記錄，確定嗎？",
  staleCleaned: "已清理 {{count}} 筆記錄",

  indexCorrupt: "標籤索引無法解析，需要重設",
  indexReset: "已重設標籤索引",
  loadFailed: "載入索引失敗：{{error}}",
  writeFailed: "寫入索引失敗：{{error}}",
  actionFailed: "操作失敗：{{error}}",
}

const MESSAGES = { en: EN, "zh-CN": ZH_CN, "zh-TW": ZH_TW }

const interpolate = (text, variables) => {
  if (!variables || typeof text !== "string") return text
  return text.replace(/{{\s*(\w+)\s*}}/g, (match, name) => (
    variables[name] === undefined ? match : String(variables[name])
  ))
}

/** Resolve a locale name the way the framework does, so `zh-Hans` and `zh-CN` agree. */
const normalizeLocale = locale => {
  const value = String(locale == null ? "" : locale)
  if (value === "zh-CN" || value === "zh-Hans") return "zh-CN"
  if (value === "zh-TW" || value === "zh-Hant") return "zh-TW"
  return LOCALES.includes(value) ? value : FALLBACK_LOCALE
}

/**
 * Wrap the framework-bound i18n object so `t()` reads from this table first.
 * The wrapper keeps every other member (`locale`, `link`, `data`, …) intact.
 */
const bindMessages = frameworkI18n => {
  const base = frameworkI18n || {}
  const locale = normalizeLocale(base.locale)
  const table = MESSAGES[locale] || MESSAGES[FALLBACK_LOCALE]
  const fallback = MESSAGES[FALLBACK_LOCALE]

  return {
    ...base,
    locale,
    t: (key, variables) => {
      const text = table[key] !== undefined ? table[key] : fallback[key]
      if (text === undefined) {
        // Unknown key: keep the framework behaviour (shared keys / the key itself).
        return typeof base.t === "function" ? base.t(key, variables) : key
      }
      return interpolate(text, variables)
    },
  }
}

module.exports = {
  LOCALES,
  FALLBACK_LOCALE,
  MESSAGES,
  normalizeLocale,
  bindMessages,
}
