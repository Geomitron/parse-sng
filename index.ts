import * as binaryParser from 'binary-parser'
import EventEmitter from 'events'
import { Readable, Transform } from 'stream'

export interface SngHeader {
  fileIdentifier: string
  version: number
  xorMask: Buffer
  metadata: { [key: string]: string }
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
export const parseSngHeader = (sngBuffer: Buffer) => {
  const metadataParser = new binaryParser.Parser()
    .int32le('keyLen')
    .string('key', { length: 'keyLen' })
    .int32le('valueLen')
    .string('value', { length: 'valueLen' })

  const fileMetaParser = new binaryParser.Parser()
    .int8('filenameLen')
    .string('filename', { length: 'filenameLen' })
    .uint64le('contentsLen')
    .uint64le('contentsIndex')

  const headerParser = new binaryParser.Parser()
    .string('fileIdentifier', { length: 6, assert: 'SNGPKG' })
    .uint32le('version')
    .buffer('xorMask', { length: 16, clone: true })
    .uint64le('metadataLen')
    .uint64le('metadataCount')
    .array('metadata', { length: 'metadataCount', type: metadataParser })
    .uint64le('fileMetaLen')
    .uint64le('fileMetaCount')
    .array('fileMeta', { length: 'fileMetaCount', type: fileMetaParser })

  const header = headerParser.parse(sngBuffer)
  const metadata: { [key: string]: string } = {}
  for (const metaSection of header.metadata) {
    metadata[metaSection.key] = metaSection.value
  }
  header.metadata = metadata
  return header as SngHeader
}

/**
 * @param header The `SngHeader` object returned from `parseSngHeader()`.
 * @param sngBuffer The .sng file buffer.
 * @param filename The name of the file to read from the .sng [file] section.
 * @throws an exception if `filename` does not match any filenames found in
 * `header.fileMeta` or if the .sng file is incorrectly formatted.
 * @returns A new `Buffer` object containing the unmasked binary contents of the file.
 */
export const readSngFile = (header: SngHeader, sngBuffer: Buffer, filename: string) => {
  const fileMeta = header.fileMeta.find(fm => fm.filename === filename)
  if (!fileMeta) {
    throw new Error(`Filename "${filename}" was not found in the .sng header.`)
  }

  const fileSize = Number(fileMeta.contentsLen)
  const fileStart = Number(fileMeta.contentsIndex)
  const unmaskedBuffer = Buffer.allocUnsafe(fileSize)
  for (let i = 0; i < fileSize; i++) {
    const xorKey = header.xorMask[i % 16] ^ (i & 0xFF)
    unmaskedBuffer[i] = sngBuffer[i + fileStart] ^ xorKey
  }

  return unmaskedBuffer
}

interface SngStreamEvents {
  'header': (header: SngHeader) => void
  'file': (fileName: string, fileStream: Readable) => void
  'files': (files: { fileName: string, fileStream: Readable }[]) => void
  'end': () => void
  'error': (error: Error) => void
}

export declare interface SngStream {
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

/**
 * A class that reads and parses a .sng `Uint8Array` stream and emits
 * events when the different components of the stream have been parsed.
 */
export class SngStream {

  private started = false
  private eventEmitter = new EventEmitter()
  private sngHeader: SngHeader | null = null
  private sngStream: Readable
  private headerChunks: Uint8Array[] = []

  private currentFileIndex = -1
  /** If a streamed chunk contains the end of one file and the start of the second, the start of the second is stored here. */
  private leftoverFileChunk: Uint8Array | null = null

  constructor(
    /**
     * @returns a `Readable` stream for the portion of the file between `byteStart` (inclusive) and `byteEnd` (inclusive).
     * If `byteEnd` is not specified, it should default to `Infinity`. This may be called multiple times to create multiple concurrent streams.
     */
    private getSngStream: (byteStart: bigint, byteEnd?: bigint) => Readable
  ) {
    this.sngStream = getSngStream(BigInt(0))
  }

  on<T extends keyof SngStreamEvents>(event: T, listener: SngStreamEvents[T]) {
    this.eventEmitter.on(event, listener)
    if (!this.started) {
      this.started = true
      this.start()
    }
  }

  private start() {
    this.sngStream.on('error', err => this.eventEmitter.emit('error', err))
    this.sngStream.on('data', chunk => this.readHeaderChunk(chunk))
  }

  private readHeaderChunk(chunk: Uint8Array) {
    this.headerChunks.push(chunk)

    const metadataLenOffset = 6 + 4 + 16
    const metadataLen = this.getPendingBytes(metadataLenOffset, 8)?.readBigUint64LE() ?? null

    if (metadataLen === null) { return } // Don't have metadataLen yet

    const fileMetaLenOffset = metadataLenOffset + 8 + Number(metadataLen)
    const fileMetaLen = this.getPendingBytes(fileMetaLenOffset, 8)?.readBigUint64LE() ?? null

    if (fileMetaLen === null) { return } // Don't have fileMetaLen yet

    const fileDataOffset = fileMetaLenOffset + 8 + Number(fileMetaLen) + 8 // Add 8 at the end for fileDataLen
    const lastHeaderByte = this.getPendingBytes(fileDataOffset - 1, 1)

    if (lastHeaderByte === null) { return } // Don't have full header yet

    // Full header has been streamed in; parse it and begin streaming individual files
    try {
      this.sngHeader = parseSngHeader(Buffer.concat(this.headerChunks, fileDataOffset))
      // Leave any leftover bytes for the next file in `leftoverFileChunk`
      this.leftoverFileChunk = this.getPendingBytes(fileDataOffset, chunk.length - fileDataOffset)

      this.eventEmitter.emit('header', this.sngHeader)
      this.sngStream.removeAllListeners('data')
      this.sngStream.pause()

      if (this.eventEmitter.listenerCount('file') > 0) {
        this.readNextFile()
      } else {
        this.readAllFiles()
      }
    } catch (err) {
      this.sngStream.destroy()
      this.eventEmitter.emit('error', err)
    }
  }

  private getPendingBytes(startIndex: number, length: number) {
    const bytes: Buffer = Buffer.alloc(length)
    let [chunkStartIndex, writeIndex] = [0, 0]
    for (const chunk of this.headerChunks) {
      if (chunkStartIndex + chunk.length <= startIndex) {
        chunkStartIndex += chunk.length
        continue // skip if too early
      }

      if (chunkStartIndex >= startIndex + length) {
        break // skip if too late
      }

      for (let i = 0; i < chunk.length; i++) {
        if (chunkStartIndex + i >= startIndex && chunkStartIndex + i < startIndex + length) {
          bytes[writeIndex] = chunk[i]
          writeIndex++
        }
      }
      chunkStartIndex += chunk.length
    }

    if (writeIndex < length) {
      return null // Bytes not available yet
    } else {
      return bytes
    }
  }

  private readNextFile() {
    this.currentFileIndex++
    const fileMeta = this.sngHeader!.fileMeta[this.currentFileIndex]
    if (!fileMeta) { // Zero files
      this.eventEmitter.emit('end')
      return
    }

    const chunkUnmasker = this.getChunkUnmasker(Number(fileMeta.contentsLen))

    const that = this
    const transform = new Transform({
      transform: function(chunk: Uint8Array, _, callback) {
        const result = chunkUnmasker(chunk)
        callback(null, result.unmaskedChunk)

        if (result.isLastChunk) {
          // There is more to read but this was the last chunk of this file; end this transform and start the next one
          this.end(() => that.readNextFile())
        } else if (that.sngStream.isPaused()) {
          // We are parsing a leftover chunk; resume sngStream to continue
          that.sngStream.pipe(this)
          that.sngStream.resume()
        }
      },
      flush: function(callback) {
        that.sngStream.unpipe(this)
        that.sngStream.pause()
        callback()
      }
    })

    this.eventEmitter.emit('file', fileMeta.filename, transform)

    transform.on('end', () => {
      if (this.currentFileIndex + 1 >= this.sngHeader!.fileMeta.length) {
        this.eventEmitter.emit('end')
      }
    })

    if (this.leftoverFileChunk) {
      // Write the leftover chunk before resuming sngStream
      transform.write(this.leftoverFileChunk)
    } else {
      // No leftover chunk; resume sngStream immediately
      this.sngStream.pipe(transform)
      this.sngStream.resume()
    }
  }

  private readAllFiles() {
    const files = this.sngHeader!.fileMeta.map(fileMeta => {
      const chunkUnmasker = this.getChunkUnmasker(Number(fileMeta.contentsLen))
      return {
        fileName: fileMeta.filename,
        fileStream: this.getSngStream(
          fileMeta.contentsIndex,
          fileMeta.contentsIndex + fileMeta.contentsLen - BigInt(1)
        ).pipe(new Transform({
          transform: function(chunk: Uint8Array, _, callback) {
            const result = chunkUnmasker(chunk)
            callback(null, result.unmaskedChunk)
          }
        }))
      }
    })

    this.eventEmitter.emit('files', files)

    let endedStreamCount = 0
    files.map(f => f.fileStream.on('end', () => {
      endedStreamCount++
      if (endedStreamCount >= this.sngHeader!.fileMeta.length) {
        this.eventEmitter.emit('end')
      }
    }))
  }

  private getChunkUnmasker(fileSize: number) {
    const xorMask = this.sngHeader!.xorMask
    let chunkStartIndex = 0

    /**
     * Unmasks `chunk` and returns it.
     * If `chunk` contains the start of the next file, it's not included and is put in `leftoverFileChunk` instead.
     */
    return (chunk: Uint8Array) => {
      const realChunkLength = Math.min(chunkStartIndex + chunk.length, fileSize) - chunkStartIndex
      const isLastChunk = realChunkLength < chunk.length

      const unmaskedChunk = Buffer.allocUnsafe(realChunkLength)
      for (let i = 0; i < realChunkLength; i++) {
        const xorKey = xorMask[(chunkStartIndex + i) % 16] ^ ((chunkStartIndex + i) & 0xFF)
        unmaskedChunk[i] = chunk[i] ^ xorKey
      }

      if (isLastChunk) {
        // Leave any leftover bytes for the next file in `leftoverFileChunk`
        this.leftoverFileChunk = Buffer.from(chunk).subarray(realChunkLength, chunk.length)
      }
      chunkStartIndex += chunk.length
      return { isLastChunk, unmaskedChunk }
    }
  }
}
