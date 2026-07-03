/**
 * POST /api/catalog/drive-folder
 *
 * Scans a public Google Drive folder and returns:
 *  - Total image count
 *  - Match preview against provided SKUs
 *  - Sample matched pairs (for user confirmation)
 *
 * Body: { folderUrl: string, skus: string[] }
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { scanDriveFolder, matchSkusToFiles } from '@/lib/catalog-import/drive-folder-scanner'

export const maxDuration = 30

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { folderUrl, skus = [] } = await request.json()
  if (!folderUrl) return NextResponse.json({ error: 'folderUrl required' }, { status: 400 })

  try {
    const files = await scanDriveFolder(folderUrl)

    const { matched, unmatched, unmatchedFiles } = matchSkusToFiles(skus, files)

    return NextResponse.json({
      totalImages: files.length,
      matched: matched.size,
      unmatched: unmatched.length,
      unmatchedFileCount: unmatchedFiles.length,
      // Sample for display
      matchedSample: Array.from(matched.entries()).slice(0, 8).map(([sku, f]) => ({
        sku,
        filename: f.filename,
        previewUrl: f.downloadUrl,
      })),
      unmatchedSkuSample: unmatched.slice(0, 8),
      // Pass file list back so map-images can use it without re-scanning
      files: files.map(f => ({
        fileId: f.fileId,
        filename: f.filename,
        normalizedName: f.normalizedName,
        downloadUrl: f.downloadUrl,
        driveViewUrl: f.driveViewUrl,
      })),
    })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 422 })
  }
}