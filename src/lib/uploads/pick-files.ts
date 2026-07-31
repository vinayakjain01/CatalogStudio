/**
 * Getting files (and their folder paths) out of the two browser entry points.
 *
 * `<input webkitdirectory>` populates `File.webkitRelativePath`, but a
 * drag-and-dropped folder does not — a drop only exposes `DataTransferItem`s
 * that must be walked recursively via the FileSystem entry API, and
 * `webkitRelativePath` is read-only so the discovered path cannot be written
 * back onto the File. Both paths therefore normalise to an explicit
 * { file, relativePath } pair, which is what the upload hook consumes.
 */

export interface PickedFile {
  file: File
  /** Path within the picked folder, POSIX separators, e.g. "shirts/red-01.jpg". */
  relativePath: string
}

/** Safety valve for someone dropping their entire home directory. */
export const MAX_PICKED_FILES = 5000

/** Minimal shape of the non-standard FileSystem entry API. */
interface EntryLike {
  isFile: boolean
  isDirectory: boolean
  name: string
  file(onSuccess: (file: File) => void, onError?: (err: unknown) => void): void
  createReader(): {
    readEntries(onSuccess: (entries: EntryLike[]) => void, onError?: (err: unknown) => void): void
  }
}

export function fromFileList(fileList: FileList | File[]): PickedFile[] {
  return Array.from(fileList)
    .slice(0, MAX_PICKED_FILES)
    .map(file => ({
      file,
      relativePath: file.webkitRelativePath || file.name,
    }))
}

function readFile(entry: EntryLike): Promise<File | null> {
  return new Promise(resolve => {
    entry.file(file => resolve(file), () => resolve(null))
  })
}

/** readEntries returns at most ~100 entries per call — loop until it's dry. */
function readAllEntries(entry: EntryLike): Promise<EntryLike[]> {
  return new Promise(resolve => {
    const reader = entry.createReader()
    const collected: EntryLike[] = []

    const readBatch = () => {
      reader.readEntries(
        batch => {
          if (batch.length === 0) return resolve(collected)
          collected.push(...batch)
          readBatch()
        },
        () => resolve(collected)
      )
    }

    readBatch()
  })
}

async function walkEntry(entry: EntryLike, prefix: string, out: PickedFile[]): Promise<void> {
  if (out.length >= MAX_PICKED_FILES) return

  const path = prefix ? `${prefix}/${entry.name}` : entry.name

  if (entry.isFile) {
    const file = await readFile(entry)
    if (file) out.push({ file, relativePath: path })
    return
  }

  if (entry.isDirectory) {
    const children = await readAllEntries(entry)
    for (const child of children) {
      await walkEntry(child, path, out)
      if (out.length >= MAX_PICKED_FILES) return
    }
  }
}

/**
 * Extract every file from a drop, descending into dropped folders.
 *
 * Falls back to `DataTransfer.files` (flat, no paths) in browsers that don't
 * implement `webkitGetAsEntry` — the user can still drop a multi-file selection,
 * just not a nested tree.
 */
export async function fromDataTransfer(dataTransfer: DataTransfer): Promise<PickedFile[]> {
  const items = Array.from(dataTransfer.items ?? [])

  const entries = items
    .map(item => (typeof item.webkitGetAsEntry === 'function'
      ? (item.webkitGetAsEntry() as unknown as EntryLike | null)
      : null))
    .filter((entry): entry is EntryLike => entry !== null)

  if (entries.length === 0) {
    return fromFileList(dataTransfer.files)
  }

  const out: PickedFile[] = []
  for (const entry of entries) {
    await walkEntry(entry, '', out)
  }

  return out
}
