export default function DriveLoading() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="space-y-1">
        <div className="h-7 w-32 bg-muted rounded" />
        <div className="h-4 w-64 bg-muted rounded" />
      </div>
      <div className="border rounded-lg p-6 space-y-4">
        <div className="h-9 w-full bg-muted rounded-md" />
        <div className="h-9 w-32 bg-muted rounded-md" />
      </div>
      <div className="border rounded-lg divide-y">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="p-3 flex items-center gap-3">
            <div className="h-8 w-8 bg-muted rounded" />
            <div className="flex-1 space-y-1">
              <div className="h-3.5 w-48 bg-muted rounded" />
              <div className="h-3 w-24 bg-muted rounded" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}