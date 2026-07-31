export default function UploadLoading() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="space-y-1">
        <div className="h-7 w-44 bg-muted rounded" />
        <div className="h-4 w-80 bg-muted rounded" />
      </div>
      <div className="border-2 border-dashed rounded-xl p-16 flex flex-col items-center gap-4">
        <div className="h-16 w-16 bg-muted rounded-2xl" />
        <div className="h-5 w-56 bg-muted rounded" />
        <div className="h-4 w-72 bg-muted rounded" />
        <div className="flex gap-2">
          <div className="h-9 w-36 bg-muted rounded-lg" />
          <div className="h-9 w-32 bg-muted rounded-lg" />
        </div>
      </div>
    </div>
  )
}
