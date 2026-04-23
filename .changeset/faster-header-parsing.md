---
"parse-sng": minor
---

Speed up `.sng` header parsing and add a `readSongIni` export for metadata-only scanners.

Header-parse throughput is ~3.3× higher across the board; metadata-only scanners using the new `readSongIni(stream)` helper are about 6× faster than the pre-existing `SngStream` event API for the same workload, because they skip the per-file `EventEmitter` / `ReadableStream` / chunk-unmasker setup that isn't needed when the caller only wants the header.

No breaking API changes. `SngStream` behavior is unchanged — only faster.
