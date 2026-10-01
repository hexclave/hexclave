export default function Loading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-3 text-muted-foreground">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-foreground/15 border-t-foreground/50" />
        <p className="text-sm">Loading...</p>
      </div>
    </div>
  );
}
