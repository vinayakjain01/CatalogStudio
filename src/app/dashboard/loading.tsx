export default function DashboardLoading() {
  return (
    <div className="space-y-8 animate-pulse">
      <div className="space-y-1">
        <div className="h-7 w-36 bg-muted rounded" />
        <div className="h-4 w-72 bg-muted rounded" />
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="border rounded-lg p-5 space-y-3 bg-card">
            <div className="flex items-center justify-between">
              <div className="h-3.5 w-28 bg-muted rounded" />
              <div className="h-4 w-4 bg-muted rounded" />
            </div>
            <div className="h-8 w-16 bg-muted rounded" />
          </div>
        ))}
      </div>
    </div>
  )
}