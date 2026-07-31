import { FolderUploadClient } from '@/components/upload/folder-upload-client'

export default function UploadProductsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Upload Products</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Pick a folder from your computer — every image inside becomes a product, ready for template generation
        </p>
      </div>
      <FolderUploadClient />
    </div>
  )
}
