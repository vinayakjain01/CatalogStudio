import { DriveImportClient } from '@/components/drive/drive-import-client'

export default function DriveImportPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Import from Google Drive</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Paste a folder link — images load automatically, ready for template generation
        </p>
      </div>
      <DriveImportClient />
    </div>
  )
}