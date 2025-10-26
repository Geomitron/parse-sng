import { createReadStream, createWriteStream } from 'fs'
import { mkdir } from 'fs/promises'
import { join, parse } from 'path'
import { Readable } from 'stream'
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import sanitize from 'sanitize-filename'
import { SngStream } from '.'

const config = yargs(hideBin(process.argv))
  .options({
    inputFile: {
      alias: 'i',
      type: 'string',
      describe: 'Path to the .sng file to parse.',
      demandOption: true,
      normalize: true,
    },
    outputFolder: {
      alias: 'o',
      type: 'string',
      describe: 'Folder to output extracted SNG files.',
      demandOption: true,
      normalize: true,
    },
    silent: {
      alias: 's',
      type: 'boolean',
      default: false,
      describe: 'Suppress all logs.',
    },
    generateSongIni: {
      alias: 'g',
      type: 'boolean',
      default: true,
      describe: 'Whether to generate a song.ini file in the output.',
    },
  })
  .help()
  .parseSync()

main()
async function main() {
  if (!config.inputFile.toLowerCase().endsWith('.sng')) {
    console.error('Error: Input file must be an .sng file.')
    process.exit(1)
  }

  if (!config.silent) {
    console.log(`Reading SNG file: ${config.inputFile}`)
  }

  const sngStream = new SngStream(
    Readable.toWeb(createReadStream(config.inputFile)) as any,
    { generateSongIni: config.generateSongIni }
  )

  sngStream.on('header', header => {
    if (!config.silent) {
      console.log('Header:', header)
    }
  })

  sngStream.on('file', async (fileName: string, fileStream: ReadableStream, nextFile) => {
    const cleanName = sanitizeNonemptyFilename(fileName).substring(0, 100)
    const outputPath = join(config.outputFolder, cleanName)

    await mkdir(parse(outputPath).dir, { recursive: true })

    if (!config.silent) {
      console.log(`Extracting: ${fileName}`)
    }

    const reader = fileStream.getReader()
    const writeStream = createWriteStream(outputPath)

    while (true) {
      const { done, value } = await reader.read()
      if (done) { break }
      writeStream.write(value)
    }
    writeStream.close()

    if (!config.silent) {
      console.log(`Wrote: ${outputPath}`)
    }

    if (nextFile) {
      nextFile()
    } else if (!config.silent) {
      console.log(`${fileName} has been fully parsed`)
    }
  })

  sngStream.on('error', error => {
    if (error instanceof Error) {
      console.log('Error: ', error.name, error.message)
    } else {
      console.log(error)
    }
    process.exit(1)
  })

  sngStream.start()
}

/**
 * @returns `filename` with all invalid filename characters replaced. Assumes `filename` has at least one valid filename character already.
 */
export function sanitizeNonemptyFilename(filename: string) {
	return sanitize(filename, {
		replacement: (invalidChar: string) => {
			switch (invalidChar) {
				case '<':
					return '❮'
				case '>':
					return '❯'
				case ':':
					return '꞉'
				case '"':
					return "'"
				case '/':
					return '／'
				case '\\':
					return '⧵'
				case '|':
					return '⏐'
				case '?':
					return '？'
				case '*':
					return '⁎'
				default:
					return '_'
			}
		},
	})
}
