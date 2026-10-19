# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- Fixed an argument-injection flaw in the UAC launch path: a `filter`/`exclude`
  value containing `\"` could end its argument early and pass extra switches to
  the elevated WizTree (for example `/treemapimagefile=`). Arguments now follow
  the exact `CommandLineToArgvW` escaping rules.
- `ScanStore.init()` now deletes only this plugin's own `wiz-*.csv` files instead
  of every stale `.csv` in a user-configured `cacheDir`.
- A symlinked or junctioned `cacheDir` is now refused, so an elevated WizTree
  cannot be redirected to write outside the intended cache directory.
- Bound `pattern` length and `list` collection size so a hostile query cannot
  spend unbounded regex time or memory.

## [1.0.0] - 2026-10-19

### Added

- `wiztree_scan` tool: indexes a Windows drive or folder through WizTree's
  command-line CSV export and reports the largest folders, files, and file
  types.
- `wiztree_query` tool: `list`, `find`, `top`, `types`, and `info` actions over
  a cached index, streamed from the CSV so a full-drive export never reaches
  the model whole.
- Automatic UAC handling for WizTree builds marked `RUNASADMIN`: direct launch
  first, then `Start-Process -Verb RunAs`, with `elevation: auto | uac | never`
  configuration.
- UTF-8 and GBK CSV decoding, streamed line parsing, and scan-index eviction
  (`maxScans`) with cache cleanup.
- Localized plugin metadata (`locale/en.json`, `locale/zh.json`) and an SVG
  icon for Plugin Manager.
