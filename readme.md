`.sng` is a simple and generic binary container format that groups a list of files and metadata into a single file. The file format specification can be found here: https://github.com/mdsitton/SngFileFormat

# API
This package provides two ways to parse .sng files:

## Parse .sng Buffer
```ts
interface SngHeader {
    fileIdentifier: string
    version: number
    xorMask: Buffer
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
function parseSngHeader(sngBuffer: Buffer): SngHeader

/**
 * @param header The `SngHeader` object returned from `parseSngHeader()`.
 * @param sngBuffer The .sng file buffer.
 * @param filename The name of the file to read from the .sng [file] section.
 * @throws an exception if `filename` does not match any filenames found in
 * `header.fileMeta` or if the .sng file is incorrectly formatted.
 * @returns A new `Buffer` object containing the unmasked binary contents of the file.
 */
function readSngFile(header: SngHeader, sngBuffer: Buffer, filename: string): Buffer
```
## Parse .sng Stream
```ts
/**
 * A class that reads and parses a .sng `Uint8Array` stream and emits
 * events when the different components of the stream have been parsed.
 */
class SngStream {

    constructor(sngStream: Readable) { }

    /**
     * Registers `listener` to be called when the .sng header has been parsed.
     * The `SngHeader` object is passed to `listener`.
     *
     * This event is emitted before any `file` events are emitted.
     */
    on(event: 'header', listener: (header: SngHeader) => void): void

    /**
     * Registers `listener` to be called when each file in .sng has started to parse.
     * The `fileName` is passed to `listener`, along with a `Readable` stream
     * for the (unmasked) binary contents of the file.
     *
     * `fileStream` will emit its `end` event before `listener` is called again
     * with the next file.
     */
    on(event: 'file', listener: (fileName: string, fileStream: Readable) => void): void

    /**
     * Registers `listener` to be called after the .sng header has been parsed.
     * An array of `Readable` streams is `listener`, along with each `fileName`.
     * The streams are for the (unmasked) binary contents of the files.
     *
     * If a listener for the `file` event is registered, this event will not fire.
     */
    on(event: 'files', listener: (files: { fileName: string, fileStream: Readable }[]) => void): void

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
# Parse .sng Stream Example
```ts
import { createReadStream } from 'fs'
import { SngStream } from 'parse-sng'

const sngStream = new SngStream((start, end) => createReadStream('C:/dev/test.sng', { start: Number(start), end: Number(end) || undefined }))

sngStream.on('header', header => {
    console.log('Header:', header)
})

sngStream.on('file', (fileName, fileStream) => {
    console.log(`Starting to read file ${fileName}`)

    const chunks: Uint8Array[] = []
    fileStream.on('data', chunk => {
        chunks.push(chunk)
    })
    fileStream.on('end', () => {
        console.log(`Finished reading file ${fileName}`)
        // Get a string for the UTF-8 text in a file with `Buffer.concat(chunks).toString()`
    })
})

sngStream.on('end', () => console.log('test.sng has been fully parsed'))

sngStream.on('error', error => console.log(error))
```