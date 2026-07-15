export default function SettingsLoading() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="h-7 w-24 bg-muted rounded" />
      <div className="border rounded-lg p-6 space-y-5">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="space-y-2">
            <div className="h-4 w-32 bg-muted rounded" />
            <div className="h-9 w-full bg-muted rounded-md" />
          </div>
        ))}
        <div className="h-9 w-24 bg-muted rounded-md" />
      </div>
    </div>
  )
}