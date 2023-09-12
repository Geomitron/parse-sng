import * as binaryParser from 'binary-parser'
import EventEmitter from 'events'

export interface SngHeader {
  fileIdentifier: string
  version: number
  xorMask: Uint8Array
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
export const parseSngHeader = (sngBuffer: Uint8Array) => {
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
 * @returns A new `Uint8Array` object containing the unmasked binary contents of the file.
 */
export const readSngFile = (header: SngHeader, sngBuffer: Uint8Array, filename: string) => {
  const fileMeta = header.fileMeta.find(fm => fm.filename === filename)
  if (!fileMeta) {
    throw new Error(`Filename "${filename}" was not found in the .sng header.`)
  }

  const fileSize = Number(fileMeta.contentsLen)
  const fileStart = Number(fileMeta.contentsIndex)
  const unmaskedBuffer = new Uint8Array(fileSize)
  for (let i = 0; i < fileSize; i++) {
    const xorKey = header.xorMask[i % 16] ^ (i & 0xFF)
    unmaskedBuffer[i] = sngBuffer[i + fileStart] ^ xorKey
  }

  return unmaskedBuffer
}

interface SngStreamEvents {
  'header': (header: SngHeader) => void
  'file': (fileName: string, fileStream: ReadableStream<Uint8Array>) => void
  'files': (files: { fileName: string, fileStream: ReadableStream<Uint8Array> }[]) => void
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

/**
 * A class that reads and parses a .sng `Uint8Array` stream and emits
 * events when the different components of the stream have been parsed.
 */
export class SngStream {

  private eventEmitter = new EventEmitter()
  private sngHeader: SngHeader | null = null
  private sngStream: ReadableStream<Uint8Array>
  private reader: ReadableStreamDefaultReader<Uint8Array>
  private headerChunks: Uint8Array[] = []

  private currentFileIndex = -1
  /** If a streamed chunk contains the end of one file and the start of the next file, the start of the next file is stored here. */
  private leftoverFileChunk: Uint8Array | null = null

  constructor(
    /**
     * @returns a `ReadableStream` for the portion of the file between `byteStart` (inclusive) and `byteEnd` (inclusive).
     * If `byteEnd` is not specified, it should default to `Infinity` or `undefined`.
     * This may be called multiple times to create multiple concurrent streams.
     */
    private getSngStream: (byteStart: bigint, byteEnd?: bigint) => ReadableStream<Uint8Array>
  ) {
    this.sngStream = getSngStream(BigInt(0))
    this.reader = this.sngStream.getReader()
  }

  on<T extends keyof SngStreamEvents>(event: T, listener: SngStreamEvents[T]) {
    this.eventEmitter.on(event, listener)
  }

  /**
   * Starts processing the provided .sng stream. Event listeners should be attached before calling this.
   */
  public async start() {
    while(true) {
      let result: ReadableStreamReadResult<Uint8Array>
      try {
        result = await this.reader.read()
      } catch(err) {
        this.eventEmitter.emit('error', err)
        return
      }

      if (result.done) {
        this.eventEmitter.emit('error', new Error('File ended before header could be parsed.'))
        return
      }

      this.headerChunks.push(result.value)

      const metadataLenOffset = 6 + 4 + 16
      const metadataLen = this.readBigUint64LE(this.getHeaderBuffer(metadataLenOffset, 8))

      if (metadataLen === null) { continue } // Don't have metadataLen yet

      const fileMetaLenOffset = metadataLenOffset + 8 + Number(metadataLen)
      const fileMetaLen = this.readBigUint64LE(this.getHeaderBuffer(fileMetaLenOffset, 8))

      if (fileMetaLen === null) { continue } // Don't have fileMetaLen yet

      const fileDataOffset = fileMetaLenOffset + 8 + Number(fileMetaLen) + 8 // Add 8 at the end for fileDataLen
      const lastHeaderByte = this.getHeaderBuffer(fileDataOffset - 1, 1)

      if (lastHeaderByte === null) { continue } // Don't have full header yet

      // Full header has been streamed in; parse it and begin streaming individual files
      try {
        this.sngHeader = parseSngHeader(this.mergeUint8Arrays(...this.headerChunks))
        // Leave any leftover bytes for the next file in `leftoverFileChunk`
        this.leftoverFileChunk = this.getHeaderBuffer(fileDataOffset, result.value.length - fileDataOffset)

        this.eventEmitter.emit('header', this.sngHeader)

        if (this.eventEmitter.listenerCount('file') > 0) {
          this.readNextFile()
        } else {
          this.readAllFiles()
        }
        return
      } catch (err) {
        this.sngStream.cancel('.sng header failed to parse.')
        this.eventEmitter.emit('error', err)
        return
      }
    }
  }

  private readBigUint64LE(buffer: Uint8Array | null) {
    if (buffer === null) { return null }
    return new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).getBigUint64(0, true)
  }

  private mergeUint8Arrays(...buffers: Uint8Array[]): Uint8Array {
    const totalSize = buffers.reduce((acc, e) => acc + e.length, 0)
    const merged = new Uint8Array(totalSize)

    buffers.forEach((array, i, arrays) => {
      const offset = arrays.slice(0, i).reduce((acc, e) => acc + e.length, 0)
      merged.set(array, offset)
    })

    return merged
  }

  private getHeaderBuffer(startIndex: number, length: number) {
    const bytes = new Uint8Array(length)
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

  private async readNextFile() {
    this.currentFileIndex++
    const fileMeta = this.sngHeader!.fileMeta[this.currentFileIndex]
    if (!fileMeta) { // No files left
      let result: ReadableStreamReadResult<Uint8Array>
      try {
        result = await this.reader.read()
      } catch(err) {
        this.eventEmitter.emit('error', err)
        return
      }

      if (result.done) {
        this.eventEmitter.emit('end')
        return
      } else {
        this.eventEmitter.emit('error', new Error('File did not end after the last listed file.'))
        return
      }
    }

    const chunkUnmasker = this.getChunkUnmasker(Number(fileMeta.contentsLen))

    const fileStream = new ReadableStream<Uint8Array>({
      start: async controller => {
        if (this.leftoverFileChunk) {
          // The start of this file was read in the previous read() result; enqueue it now
          const chunk = this.leftoverFileChunk
          this.leftoverFileChunk = null
          const { totalProcessedBytes, unmaskedChunk } = chunkUnmasker(chunk)

          controller.enqueue(unmaskedChunk)
          if (totalProcessedBytes >= Number(fileMeta.contentsLen)) {
            controller.close()
            this.readNextFile()
            return
          }
        }

        while(true) {
          if (controller.desiredSize !== null && controller.desiredSize <= 0) {
            await new Promise<void>(resolve => setTimeout(resolve, 30))
            continue
          }
          let result: ReadableStreamReadResult<Uint8Array>
          try {
            result = await this.reader.read()
          } catch(err) {
            controller.error(err)
            this.eventEmitter.emit('error', err)
            return
          }

          if (result.done) {
            controller.error(new Error('File ended before file could be parsed.'))
            this.eventEmitter.emit('error', new Error('File ended before all files could be parsed.'))
            return
          }

          const { totalProcessedBytes, unmaskedChunk } = chunkUnmasker(result.value)

          controller.enqueue(unmaskedChunk)
          if (totalProcessedBytes >= Number(fileMeta.contentsLen)) {
            controller.close()
            this.readNextFile()
            return
          }
        }
      },
      cancel: () => {
        this.reader.cancel('Stream was manually canceled.')
        this.eventEmitter.emit('end')
      }
    })

    this.eventEmitter.emit('file', fileMeta.filename, fileStream)
  }

  private readAllFiles() {
    this.reader.cancel('Using individual readers for each file.')
    let endedStreamCount = 0

    const files = this.sngHeader!.fileMeta.map(fileMeta => {
      const chunkUnmasker = this.getChunkUnmasker(Number(fileMeta.contentsLen))
      const sngStream = this.getSngStream(fileMeta.contentsIndex, fileMeta.contentsIndex + fileMeta.contentsLen - BigInt(1))
      const reader = sngStream.getReader()
      return {
        fileName: fileMeta.filename,
        fileStream: new ReadableStream<Uint8Array>({
          start: async controller => {
            while(true) {
              if (controller.desiredSize !== null && controller.desiredSize <= 0) {
                await new Promise<void>(resolve => setTimeout(resolve, 30))
                continue
              }
              let result: ReadableStreamReadResult<Uint8Array>
              try {
                result = await reader.read()
              } catch(err) {
                controller.error(err)
                this.eventEmitter.emit('error', err)
                return
              }

              if (result.done) {
                controller.close()
                endedStreamCount++
                if (endedStreamCount >= this.sngHeader!.fileMeta.length) {
                  this.eventEmitter.emit('end')
                }
                return
              }

              const unmaskedResult = chunkUnmasker(result.value)
              controller.enqueue(unmaskedResult.unmaskedChunk)
            }
          },
          cancel: () => {
            reader.cancel()
            endedStreamCount++
            if (endedStreamCount >= this.sngHeader!.fileMeta.length) {
              this.eventEmitter.emit('end')
            }
          }
        })
      }
    })

    this.eventEmitter.emit('files', files)
  }

  private getChunkUnmasker(fileSize: number) {
    const xorMask = this.sngHeader!.xorMask
    let chunkStartIndex = 0

    /**
     * Unmasks `chunk` and returns it.
     * If `chunk` contains the start of the next file, it's not included and is put in `leftoverFileChunk` instead.
     */
    return (chunk: Uint8Array) => {
      const usedChunkLength = Math.min(chunkStartIndex + chunk.length, fileSize) - chunkStartIndex

      const unmaskedChunk = new Uint8Array(usedChunkLength)
      for (let i = 0; i < usedChunkLength; i++) {
        const xorKey = xorMask[(chunkStartIndex + i) % 16] ^ ((chunkStartIndex + i) & 0xFF)
        unmaskedChunk[i] = chunk[i] ^ xorKey
      }

      if (usedChunkLength < chunk.length) {
        // Leave any leftover bytes for the next file in `leftoverFileChunk`
        this.leftoverFileChunk = chunk.subarray(usedChunkLength, chunk.length)
      }
      chunkStartIndex += chunk.length
      return { totalProcessedBytes: chunkStartIndex, unmaskedChunk }
    }
  }
}
