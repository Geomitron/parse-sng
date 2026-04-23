import * as binaryParser from 'binary-parser'
import { EventEmitter } from 'eventemitter3'

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

export interface SngStreamConfig {
  /**
   * The .sng format doesn't list a `song.ini` file in the `fileMeta`; that information is stored in `metadata`.
   *
   * Set this to true for `SngStream` to generate and emit a `song.ini` file in the `file` or `files` events.
   *
   * Default: `false`.
   */
  generateSongIni: boolean
}

interface SngStreamEvents {
  header: (header: SngHeader) => void
  file: (fileName: string, fileStream: ReadableStream<Uint8Array>, nextFile: (() => void) | null) => void
  error: (error: unknown) => void
}

export declare interface SngStream {
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
   * It will usually by type `Error`. (error instanceof Error === true)
   *
   * This can either happen when `sngStream` emits an `error` event, or
   * if the .sng's header failed to parse.
   */
  on(event: 'error', listener: (error: unknown) => void): void
}

/**
 * A class that reads and parses a .sng `Uint8Array` stream and emits
 * events when the different components of the stream have been parsed.
 */
export class SngStream {

	private config: SngStreamConfig

  private eventEmitter = new EventEmitter<SngStreamEvents>()
  private sngHeader: SngHeader | null = null
  private reader: ReadableStreamDefaultReader<Uint8Array>
  /** Single growing buffer holding the header bytes accumulated so far. */
  private headerBuffer: Uint8Array | null = null
  private headerBufferedBytes = 0

  /** If a streamed chunk contains the end of one file and the start of the next file, the start of the next file is stored here. */
  private leftoverFileChunk: Uint8Array | null = null

  constructor(
    /**
     * A `ReadableStream` for the binary contents of the .sng file.
     */
    private sngStream: ReadableStream<Uint8Array>,
    config?: SngStreamConfig,
  ) {
		this.config = {
			generateSongIni: false,
			...config,
		}
    this.reader = this.sngStream.getReader()
  }

  on<T extends keyof SngStreamEvents>(event: T, listener: SngStreamEvents[T]) {
    this.eventEmitter.on(event, listener as any)
  }

  /**
   * Starts processing the provided .sng stream. Event listeners should be attached before calling this.
   */
  public start() {
    this._start()
  }
  private async _start() {
    try {
      while(true) {
        const result = await this.reader.read()

        if (result.done) {
          throw new Error('File ended before header could be parsed.')
        }

        this.appendHeaderChunk(result.value)

        const metadataLenOffset = 6 + 4 + 16
        const metadataLen = this.readHeaderBigUint64LE(metadataLenOffset)

        if (metadataLen === null) { continue } // Don't have metadataLen yet

        const fileMetaLenOffset = metadataLenOffset + 8 + Number(metadataLen)
        const fileMetaLen = this.readHeaderBigUint64LE(fileMetaLenOffset)

        if (fileMetaLen === null) { continue } // Don't have fileMetaLen yet

        const fileDataOffset = fileMetaLenOffset + 8 + Number(fileMetaLen) + 8 // Add 8 at the end for fileDataLen

        if (this.headerBufferedBytes < fileDataOffset) { continue } // Don't have full header yet

        // Full header has been streamed in; parse it and begin streaming individual files
        const headerBuf = this.headerBuffer!
        this.sngHeader = parseSngHeader(headerBuf.subarray(0, fileDataOffset))

        // Leave any leftover bytes for the next file in `leftoverFileChunk`
        const leftoverLen = this.headerBufferedBytes - fileDataOffset
        this.leftoverFileChunk = leftoverLen > 0
          ? headerBuf.slice(fileDataOffset, this.headerBufferedBytes)
          : null

        // Release the header buffer; parseSngHeader has already extracted all strings/xorMask.
        this.headerBuffer = null

        if (this.config.generateSongIni) {
          const iniFileTextBuffer = generateIniFileText(this.sngHeader)
          this.sngHeader.fileMeta.unshift({ filename: 'song.ini', contentsIndex: BigInt(-1), contentsLen: BigInt(iniFileTextBuffer.length) })

          this.eventEmitter.emit('header', this.sngHeader)

          await new Promise<void>(resolve => {
            this.eventEmitter.emit('file', 'song.ini', new ReadableStream<Uint8Array>({
              start: async controller => {
                controller.enqueue(iniFileTextBuffer)
                controller.close()
              }
            }), this.sngHeader!.fileMeta.length > 1 ? resolve : null)
          })
          if (this.sngHeader!.fileMeta.length > 1) {
            this.readFile(this.sngHeader!.fileMeta[1])
          }
        } else {
          this.eventEmitter.emit('header', this.sngHeader)

          if (this.sngHeader!.fileMeta.length > 0) {
            this.readFile(this.sngHeader!.fileMeta[0])
          }
        }
        return
      }
    } catch (err) {
      this.reader.releaseLock()
      await this.sngStream.cancel('.sng header failed to parse.').catch(() => {}) // Ignored; is a duplicate of `err`
      this.eventEmitter.emit('error', err)
    }
  }

  private appendHeaderChunk(chunk: Uint8Array) {
    if (this.headerBuffer === null) {
      this.headerBuffer = chunk
      this.headerBufferedBytes = chunk.length
      return
    }
    const newTotal = this.headerBufferedBytes + chunk.length
    if (newTotal > this.headerBuffer.length) {
      const newCap = Math.max(newTotal, this.headerBuffer.length * 2)
      const grown = new Uint8Array(newCap)
      grown.set(this.headerBuffer.subarray(0, this.headerBufferedBytes))
      this.headerBuffer = grown
    }
    this.headerBuffer.set(chunk, this.headerBufferedBytes)
    this.headerBufferedBytes = newTotal
  }

  private readHeaderBigUint64LE(offset: number): bigint | null {
    if (this.headerBuffer === null || this.headerBufferedBytes < offset + 8) { return null }
    return new DataView(this.headerBuffer.buffer, this.headerBuffer.byteOffset + offset, 8).getBigUint64(0, true)
  }

  private async readFile(fileMeta: SngHeader['fileMeta'][number]) {
    // TODO: File did not end after the last listed file.
    const chunkUnmasker = this.getChunkUnmasker(fileMeta.contentsLen)

    const fileStream = new ReadableStream<Uint8Array>({
      start: async controller => {
        if (fileMeta.contentsLen === BigInt(0)) {
          controller.close()
        }
      },
      pull: async controller => {
        try {
          // If the start of this file was read in the previous read() result,
          // unmask and enqueue it now. Deferring this out of `start` means the
          // XOR work is skipped entirely when a consumer cancels immediately
          // after the `file` event (e.g. metadata-only scanners).
          if (this.leftoverFileChunk) {
            const chunk = this.leftoverFileChunk
            this.leftoverFileChunk = null
            const { totalProcessedBytes, unmaskedChunk } = chunkUnmasker(chunk)
            controller.enqueue(unmaskedChunk)
            if (totalProcessedBytes >= fileMeta.contentsLen) {
              controller.close()
            }
            return
          }

          const result = await this.reader.read()

          if (result.done) {
            throw new Error('File ended before all files could be parsed.')
          }

          const { totalProcessedBytes, unmaskedChunk } = chunkUnmasker(result.value)
          controller.enqueue(unmaskedChunk)
          if (totalProcessedBytes >= fileMeta.contentsLen) {
            controller.close()
          }
        } catch(err) {
          this.reader.releaseLock()
          await this.sngStream.cancel().catch(() => {}) // Ignored; is a duplicate of `err`
          this.eventEmitter.emit('error', err)
        }
      },
      cancel: async () => {
        this.reader.releaseLock()
        await this.sngStream.cancel('Stream was manually canceled.').catch(err => this.eventEmitter.emit('error', err))
      }
    })

    const nextFileMeta = this.sngHeader!.fileMeta[this.sngHeader!.fileMeta.findIndex(fm => fm === fileMeta) + 1] ?? null
    this.eventEmitter.emit('file', fileMeta.filename, fileStream, nextFileMeta ? () => this.readFile(nextFileMeta) : null)
  }

  private getChunkUnmasker(fileSize: bigint) {
    const xorMask = this.sngHeader!.xorMask
    let chunkStartIndex = BigInt(0)

    /**
     * Unmasks `chunk` and returns it.
     * If `chunk` contains the start of the next file, it's not included and is put in `leftoverFileChunk` instead.
     */
    return (chunk: Uint8Array) => {
      const maxEndIndex = chunkStartIndex + BigInt(chunk.length)
      const usedChunkLength = Number(maxEndIndex > fileSize ? fileSize - chunkStartIndex : maxEndIndex - chunkStartIndex)

      const unmaskedChunk = new Uint8Array(usedChunkLength)
      // The variable that cycles between 0 and 255 based on chunkStartIndex
      let cyclicIndex = Number(chunkStartIndex % BigInt(256))
      for (let i = 0; i < usedChunkLength; i++) {
        const xorKey = xorMask[cyclicIndex % 16] ^ cyclicIndex
        unmaskedChunk[i] = chunk[i] ^ xorKey
        // Increment cyclicIndex and wrap around if it exceeds 255
        cyclicIndex = (cyclicIndex + 1) % 256
      }

      if (usedChunkLength < chunk.length) {
        // Leave any leftover bytes for the next file in `leftoverFileChunk`
        this.leftoverFileChunk = chunk.subarray(usedChunkLength, chunk.length)
      }
      chunkStartIndex += BigInt(chunk.length)
      return { totalProcessedBytes: chunkStartIndex, unmaskedChunk }
    }
  }
}

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

/**
 * @param sngBuffer The .sng file buffer.
 * @throws an exception if the .sng file is incorrectly formatted.
 * @returns A `SngHeader` object containing the .sng file's metadata.
 */
function parseSngHeader(sngBuffer: Uint8Array) {
  const header = headerParser.parse(sngBuffer)
  const metadata: { [key: string]: string } = {}
  for (const metaSection of header.metadata) {
    metadata[metaSection.key] = metaSection.value
  }
  header.metadata = metadata
  return header as SngHeader
}

/**
 * Reads just enough of `sngStream` to parse the .sng header, then
 * cancels the source stream and returns the song.ini key/value data as
 * a plain object (same shape `SngHeader.metadata` has on the full
 * header). No file-content events are emitted and the file bytes
 * following the header are never touched.
 *
 * Use this when you only need a file's metadata (e.g. to build a
 * library index or scan song.ini data) — it avoids the per-file
 * streaming setup that `SngStream` does.
 *
 * @throws if the stream ends before a full header has been read, or the
 *   header bytes fail to parse.
 */
export async function readSongIni(sngStream: ReadableStream<Uint8Array>): Promise<{ [key: string]: string }> {
  const reader = sngStream.getReader()
  let buffer: Uint8Array | null = null
  let buffered = 0

  try {
    while (true) {
      const result = await reader.read()
      if (result.done) {
        throw new Error('File ended before header could be parsed.')
      }

      if (buffer === null) {
        buffer = result.value
        buffered = result.value.length
      } else {
        const newTotal = buffered + result.value.length
        if (newTotal > buffer.length) {
          const newCap = Math.max(newTotal, buffer.length * 2)
          const grown = new Uint8Array(newCap)
          grown.set(buffer.subarray(0, buffered))
          buffer = grown
        }
        buffer.set(result.value, buffered)
        buffered = newTotal
      }

      const metadataLenOffset = 6 + 4 + 16
      if (buffered < metadataLenOffset + 8) { continue }
      const metadataLen = new DataView(buffer.buffer, buffer.byteOffset + metadataLenOffset, 8).getBigUint64(0, true)

      const fileMetaLenOffset = metadataLenOffset + 8 + Number(metadataLen)
      if (buffered < fileMetaLenOffset + 8) { continue }
      const fileMetaLen = new DataView(buffer.buffer, buffer.byteOffset + fileMetaLenOffset, 8).getBigUint64(0, true)

      const fileDataOffset = fileMetaLenOffset + 8 + Number(fileMetaLen) + 8 // Add 8 at the end for fileDataLen
      if (buffered < fileDataOffset) { continue }

      const header = parseSngHeader(buffer.subarray(0, fileDataOffset))
      return header.metadata
    }
  } finally {
    try { reader.releaseLock() } catch {}
    sngStream.cancel('Header read; source canceled.').catch(() => {})
  }
}

function generateIniFileText(sngHeader: SngHeader | null) {
  const headerKeys = Object.keys(sngHeader?.metadata ?? {})
  if (!sngHeader || !headerKeys.length) { return new TextEncoder().encode('[song]\n') }

  let iniText = '[song]\n'
  for (const key of defaultKeys) {
    if (sngHeader.metadata[key] && sngHeader.metadata[key] !== defaultMetadata[key]) {
      iniText += `${key} = ${sngHeader.metadata[key]}\n`
    }
  }
  for (const key of headerKeys) {
    if (defaultKeys.includes(key)) { continue }
    iniText += `${key} = ${sngHeader.metadata[key]}\n`
  }
  return new TextEncoder().encode(iniText)
}

const defaultMetadata = {
	'name': 'Unknown Name',
	'artist': 'Unknown Artist',
	'album': 'Unknown Album',
	'genre': 'Unknown Genre',
	'year': 'Unknown Year',
	'charter': 'Unknown Charter',
	/** Units of ms */ 'song_length': '0',
	'diff_band': '-1',
	'diff_guitar': '-1',
	'diff_guitar_coop': '-1',
	'diff_rhythm': '-1',
	'diff_bass': '-1',
	'diff_drums': '-1',
	'diff_drums_real': '-1',
	'diff_keys': '-1',
	'diff_guitarghl': '-1',
	'diff_guitar_coop_ghl': '-1',
	'diff_rhythm_ghl': '-1',
	'diff_bassghl': '-1',
	'diff_vocals': '-1',
	/** Units of ms */ 'preview_start_time': '-1',
	'icon': '',
	'loading_phrase': '',
	'album_track': '16000',
	'playlist_track': '16000',
  'playlist': '',
	'modchart': 'False',
	/** Units of ms */ 'delay': '0',
	'hopo_frequency': '0',
	'eighthnote_hopo': 'False',
	'multiplier_note': '0',
	'video_start_time': '0',
	'five_lane_drums': 'False',
	'pro_drums': 'False',
	'end_events': 'True',
} as { [key: string]: string }
const defaultKeys = Object.keys(defaultMetadata)
