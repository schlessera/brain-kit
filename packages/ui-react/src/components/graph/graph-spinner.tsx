import { Loader2 } from "lucide-react";

export function CenteredSpinner() {
  return (
    <div className="flex h-full items-center justify-center">
      <Loader2 className="h-6 w-6 animate-spin text-primary" />
    </div>
  );
}
