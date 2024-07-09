`.sng` is a simple and generic binary container format that groups a list of files and metadata into a single file. The file format specification can be found here: https://github.com/mdsitton/SngFileFormat

Works in a browser context and Node.js v17.0.0 and later.

# API
```ts
/**
 * A class that reads and parses a .sng `Uint8Array` stream and emits
 * events when the different components of the stream have been parsed.
 */
class SngStream {

    constructor(
        /**
         * A `ReadableStream` for the binary contents of the .sng file.
         */
        sngStream: ReadableStream<Uint8Array>,
        config?: SngStreamConfig,
    ) { }

    /**
     * Starts processing the provided .sng stream. Event listeners should be attached before calling this.
     */
    start(): void

    /**
     * Registers `listener` to be called once when the .sng header has been parsed.
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
     * If `nextFile` is `null`, there are no more files to read.
     * Otherwise, `nextFile` must be called to emit the next file event.
     *
     * Cancelling `fileStream` will cancel the source stream.
     */
    on(event: 'file', listener: (fileName: string, fileStream: ReadableStream<Uint8Array>, nextFile: (() => void) | null) => void): void

    /**
     * Registers `listener` to be called once if an error occurs during the stream.
     *
     * The source stream is canceled and the error is passed to the listener.
     * It will usually by type `Error`. ((error instanceof Error) === true)
     *
     * This can either happen when `sngStream` emits an `error` event, or
     * if the .sng's header failed to parse.
     */
    on(event: 'error', listener: (error: unknown) => void): void
}

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
```
# Parse .sng Stream Node.js Example
```ts
import { createReadStream, createWriteStream } from 'fs'
import { SngStream } from 'parse-sng'
import { Readable } from 'stream'
import { mkdir } from 'fs/promises'
import { join, parse } from 'path'

const sngStream = new SngStream(
  Readable.toWeb(createReadStream('C:/dev/test.sng')) as any,
  { generateSongIni: true },
)

sngStream.on('header', header => {
    console.log('Header:', header)
})

sngStream.on('file', async (fileName, fileStream, nextFile) => {
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

  if (nextFile) {
    nextFile()
  } else {
    console.log('test.sng has been fully parsed')
  }
})

sngStream.on('error', error => {
  if (error instanceof Error) {
    console.log('Error: ', error.name, error.message)
  } else {
    console.log(error)
  }
})

sngStream.start()
```