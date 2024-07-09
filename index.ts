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
  private headerChunks: Uint8Array[] = []

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

        this.headerChunks.push(result.value)

        const metadataLenOffset = 6 + 4 + 16
        const metadataLen = readBigUint64LE(this.getHeaderBuffer(metadataLenOffset, 8))

        if (metadataLen === null) { continue } // Don't have metadataLen yet

        const fileMetaLenOffset = metadataLenOffset + 8 + Number(metadataLen)
        const fileMetaLen = readBigUint64LE(this.getHeaderBuffer(fileMetaLenOffset, 8))

        if (fileMetaLen === null) { continue } // Don't have fileMetaLen yet

        const fileDataOffset = fileMetaLenOffset + 8 + Number(fileMetaLen) + 8 // Add 8 at the end for fileDataLen
        const lastHeaderByte = this.getHeaderBuffer(fileDataOffset - 1, 1)

        if (lastHeaderByte === null) { continue } // Don't have full header yet

        // Full header has been streamed in; parse it and begin streaming individual files
        this.sngHeader = parseSngHeader(mergeUint8Arrays(...this.headerChunks))
        // Leave any leftover bytes for the next file in `leftoverFileChunk`
        const lastChunkStartIndex = this.headerChunks.slice(0, -1).map(c => c.length).reduce((a, b) => a + b, 0)
        this.leftoverFileChunk = this.getHeaderBuffer(fileDataOffset, (lastChunkStartIndex + result.value.length) - fileDataOffset)

        this.eventEmitter.emit('header', this.sngHeader)

        if (this.config.generateSongIni) {
          await new Promise<void>(resolve => {
            this.eventEmitter.emit('file', 'song.ini', new ReadableStream<Uint8Array>({
              start: async controller => {
                controller.enqueue(generateIniFileText(this.sngHeader))
                controller.close()
              }
            }), this.sngHeader!.fileMeta.length > 0 ? resolve : null)
          })
        }

        if (this.sngHeader!.fileMeta.length > 0) {
          this.readFile(this.sngHeader!.fileMeta[0])
        }
        return
      }
    } catch (err) {
      this.reader.releaseLock()
      await this.sngStream.cancel('.sng header failed to parse.').catch(() => {}) // Ignored; is a duplicate of `err`
      this.eventEmitter.emit('error', err)
    }
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

  private async readFile(fileMeta: SngHeader['fileMeta'][number]) {
    // TODO: File did not end after the last listed file.
    const chunkUnmasker = this.getChunkUnmasker(fileMeta.contentsLen)

    const fileStream = new ReadableStream<Uint8Array>({
      start: async controller => {
        if (fileMeta.contentsLen === BigInt(0)) {
          controller.close()
        } else if (this.leftoverFileChunk) {
          // The start of this file was read in the previous read() result; enqueue it now
          const chunk = this.leftoverFileChunk
          this.leftoverFileChunk = null
          const { totalProcessedBytes, unmaskedChunk } = chunkUnmasker(chunk)

          controller.enqueue(unmaskedChunk)
          if (totalProcessedBytes >= fileMeta.contentsLen) {
            controller.close()
          }
        }
      },
      pull: async controller => {
        try {
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

function readBigUint64LE(buffer: Uint8Array | null) {
  if (buffer === null) { return null }
  return new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).getBigUint64(0, true)
}

function mergeUint8Arrays(...buffers: Uint8Array[]): Uint8Array {
  const totalSize = buffers.reduce((acc, e) => acc + e.length, 0)
  const merged = new Uint8Array(totalSize)

  buffers.forEach((array, i, arrays) => {
    const offset = arrays.slice(0, i).reduce((acc, e) => acc + e.length, 0)
    merged.set(array, offset)
  })

  return merged
}

/**
 * @param sngBuffer The .sng file buffer.
 * @throws an exception if the .sng file is incorrectly formatted.
 * @returns A `SngHeader` object containing the .sng file's metadata.
 */
function parseSngHeader(sngBuffer: Uint8Array) {
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
