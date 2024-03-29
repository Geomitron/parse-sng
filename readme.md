`.sng` is a simple and generic binary container format that groups a list of files and metadata into a single file. The file format specification can be found here: https://github.com/mdsitton/SngFileFormat

Works in a browser context and Node.js v17.0.0 and later.

# API
This package provides two ways to parse .sng files:

## Parse .sng Buffer
```ts
interface SngHeader {
    fileIdentifier: string
    version: number
    xorMask: Uint8Array
    metadata: {
        [key: string]: string
    }
    fileMeta: {
        filename: string
        contentsLen: bigint
        contentsIndex: bigint
    }[]
}

/**
 * @param sngBuffer The .sng file buffer.
 * @throws an exception if the .sng file is incorrectly formatted.
 * @returns A `SngHeader` object containing the .sng file's metadata.
 */
function parseSngHeader(sngBuffer: Uint8Array): SngHeader

/**
 * @param header The `SngHeader` object returned from `parseSngHeader()`.
 * @param sngBuffer The .sng file buffer.
 * @param filename The name of the file to read from the .sng [file] section.
 * @throws an exception if `filename` does not match any filenames found in
 * `header.fileMeta` or if the .sng file is incorrectly formatted.
 * @returns A new `Uint8Array` object containing the unmasked binary contents of the file.
 */
function readSngFile(header: SngHeader, sngBuffer: Uint8Array, filename: string): Uint8Array
```
## Parse .sng Stream
```ts
interface SngStreamConfig {
  /**
   * The .sng format doesn't list a `song.ini` file in the `fileMeta`; that information is stored in `metadata`.
   *
   * Set this to true for `SngStream` to generate and emit a `song.ini` file in the `file` or `files` events.
   *
   * Default: `false`.
   */
  generateSongIni: boolean
}

/**
 * A class that reads and parses a .sng `Uint8Array` stream and emits
 * events when the different components of the stream have been parsed.
 */
class SngStream {

    constructor(
        /**
         * @returns a `ReadableStream` for the portion of the file between `byteStart` (inclusive) and `byteEnd` (inclusive).
         * If `byteEnd` is not specified, it should default to `Infinity` or `undefined`.
         * This may be called multiple times to create multiple concurrent streams.
         */
        getSngStream: (byteStart: bigint, byteEnd?: bigint) => ReadableStream<Uint8Array>,
        config?: SngStreamConfig,
    ) { }

    /**
     * Starts processing the provided .sng stream. Event listeners should be attached before calling this.
     */
    start(): Promise<void>

    /**
     * Registers `listener` to be called when the .sng header has been parsed.
     * The `SngHeader` object is passed to `listener`.
     *
     * This event is emitted before any `file` events are emitted.
     */
    on(event: 'header', listener: (header: SngHeader) => void): void

    /**
     * Registers `listener` to be called when each file in .sng has started to parse.
     * The `fileName` is passed to `listener`, along with a `ReadableStream`
     * for the (unmasked) binary contents of the file.
     *
     * `fileStream` will emit its `end` event before `listener` is called again
     * with the next file.
     *
     * Note: using this event will only cause `getSngStream()` to be called once.
     * Handling `byteStart` and `byteEnd` is not necessary.
     *
     * Cancelling `fileStream` will prevent any more `file` events from emitting.
     * The source stream is canceled, and the `end` event fires.
     */
    on(event: 'file', listener: (fileName: string, fileStream: ReadableStream<Uint8Array>) => void): void

    /**
     * Registers `listener` to be called after the .sng header has been parsed.
     * An array of `ReadableStream`s is `listener`, along with each `fileName`.
     * The streams are for the (unmasked) binary contents of the files.
     *
     * If a listener for the `file` event is registered, this event will not fire.
     *
     * Note: using this event will cause `getSngStream()` to be called once for
     * getting the header and once for each individual file.
     *
     * `fileStream`s can be cancelled. This will not affect other `fileStream`s.
     */
    on(event: 'files', listener: (files: { fileName: string, fileStream: ReadableStream<Uint8Array> }[]) => void): void

    /**
     * Registers `listener` to be called when the .sng file has been fully streamed
     * during the `file` or `files` events.
     *
     * This event is emitted after the `end` event of the last `fileStream`.
     */
    on(event: 'end', listener: () => void): void

    /**
     * Registers `listener` to be called if an error occurs during the stream.
     *
     * The `Error` object is passed to `listener`.
     *
     * This can either happen when `sngStream` emits an `error` event, or
     * if the .sng's header failed to parse.
     */
    on(event: 'error', listener: (error: Error) => void): void
}
```
# Parse .sng Stream Node.js Example
```ts
import { createReadStream, createWriteStream } from 'fs'
import { SngStream } from 'parse-sng'
import { Readable } from 'stream'
import { mkdir } from 'fs/promises'
import { join, parse } from 'path'

const sngStream = new SngStream(
  (start, end) => Readable.toWeb(
    createReadStream('C:/dev/test.sng', { start: Number(start), end: Number(end) || undefined })
  ) as ReadableStream<Uint8Array>,
  { generateSongIni: true },
)

sngStream.on('header', header => {
    console.log('Header:', header)
})

sngStream.on('files', files => {
  files.forEach(async ({ fileName, fileStream }) => {
    console.log(`Starting to read file ${fileName}`)
    const reader = fileStream.getReader()

    await mkdir(join('C:/dev/output', parse(fileName).dir), { recursive: true })
    const writeStream = createWriteStream(join('C:/dev/output', fileName))
    while(true) {
      const { done, value } = await reader.read()
      if (done) { break }
      writeStream.write(value)
    }
    writeStream.close()

    console.log(`Finished reading file ${fileName}`)
  })
})

sngStream.on('end', () => console.log('test.sng has been fully parsed'))

sngStream.on('error', error => console.log(error))

sngStream.start()
```